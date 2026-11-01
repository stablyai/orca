import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as ProfileCloudClient from './profile-cloud-client'
import type * as SecureFile from '../../shared/secure-file'
import type { OrcaCloudSession } from './profile-cloud-session-store'

const net = vi.hoisted(() => ({
  exchange: vi.fn(),
  refresh: vi.fn(),
  selectOrg: vi.fn(),
  capabilities: vi.fn(),
  revoke: vi.fn()
}))

const disk = vi.hoisted(() => ({ failSessionWrites: 0 }))

vi.mock('../../shared/secure-file', async (importOriginal) => {
  const original = await importOriginal<typeof SecureFile>()
  return {
    ...original,
    writeSecureJsonFile: (path: string, value: unknown) => {
      if (path.endsWith('account-session.json.enc') && disk.failSessionWrites > 0) {
        disk.failSessionWrites--
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
      return original.writeSecureJsonFile(path, value)
    }
  }
})

vi.mock('electron', () => ({
  app: { isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    decryptString: (value: Buffer) => value.toString('utf-8')
  }
}))

vi.mock('./profile-cloud-pkce', () => ({
  beginOrcaCloudPkceFlow: vi.fn(async () => ({
    code: 'code',
    codeVerifier: 'verifier',
    nonce: 'nonce',
    redirectUri: 'http://127.0.0.1/callback',
    state: 'state'
  }))
}))

vi.mock('./profile-cloud-client', async (importOriginal) => {
  const original = await importOriginal<typeof ProfileCloudClient>()
  return {
    ...original,
    exchangeOrcaCloudAuthCode: net.exchange,
    refreshOrcaCloudSession: net.refresh,
    selectOrcaCloudOrg: net.selectOrg,
    refreshOrcaCloudCapabilities: net.capabilities,
    revokeOrcaCloudSession: net.revoke
  }
})

import { OrcaCloudRequestError } from './profile-cloud-client'
import {
  connectCurrentOrcaProfile,
  getCurrentOrcaProfileAuthStatus,
  refreshCurrentOrcaProfileAuth,
  selectCurrentOrcaProfileOrg,
  signOutCurrentOrcaProfile
} from './profile-cloud-service'
import { readOrcaCloudSession } from './profile-cloud-session-store'
import { getOrcaCloudAuthConfig } from './profile-cloud-auth-config'
import { runWithFreshOrcaCloudSession } from './profile-cloud-session-refresh'
import { onOrcaCloudSessionInvalidated } from './profile-cloud-session-invalidation'
import {
  createLocalOrcaProfile,
  ensureActiveOrcaProfile,
  setActiveOrcaProfile
} from './profile-index-store'
import { readRelayAuthContext } from '../runtime/mobile-cloud-relay/relay-auth-context'
import { runSkillCloudOperation } from '../skills/skill-cloud-auth'

const cloud = (orgId = 'org-1') => ({
  userId: 'user-1',
  cloudProfileId: 'cloud-profile-1',
  email: 'user@example.com',
  activeOrgId: orgId,
  linkedAt: 1
})
const orgs = [
  { orgId: 'org-1', name: 'One' },
  { orgId: 'org-2', name: 'Two' }
]
let issued = 0
const issue = (options: { expiresIn?: number; orgId?: string; relay?: boolean } = {}) => {
  issued++
  return {
    accessToken: `access-${issued}`,
    refreshToken: `refresh-${issued}`,
    expiresAt: Date.now() + (options.expiresIn ?? 600_000),
    organizations: orgs,
    capabilities: { flags: { 'relay.use': options.relay ?? true }, refreshedAt: Date.now() },
    cloud: cloud(options.orgId)
  }
}

let userDataPath = ''
const authConfig = () => {
  const state = getOrcaCloudAuthConfig()
  if (!state.configured) {
    throw new Error('auth config not configured')
  }
  return state.config
}
const stored = (profileId = ensureActiveOrcaProfile(userDataPath).profile.id) =>
  readOrcaCloudSession(profileId, userDataPath)
const storedRefreshToken = (profileId?: string) => {
  const session = stored(profileId)
  return session.status === 'found' ? session.session.refreshToken : session.status
}

async function signIn(expiresIn = 600_000): Promise<void> {
  net.exchange.mockResolvedValueOnce(issue({ expiresIn }))
  await expect(connectCurrentOrcaProfile(userDataPath)).resolves.toMatchObject({
    status: 'connected'
  })
}

describe('cloud auth characterization', () => {
  beforeEach(() => {
    vi.stubEnv('ORCA_CLOUD_API_URL', 'http://localhost:4100')
    vi.stubEnv('ORCA_CLOUD_CLIENT_ID', 'desktop-client')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-auth-characterization-'))
    for (const mock of Object.values(net)) {
      mock.mockReset()
    }
    net.revoke.mockResolvedValue(undefined)
    disk.failSessionWrites = 0
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  describe('sign-in', () => {
    it('stores the exchanged session and links the profile', async () => {
      await signIn()
      expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({
        state: 'connected',
        persistence: 'encrypted',
        cloud: { userId: 'user-1', activeOrgId: 'org-1' }
      })
      expect(storedRefreshToken()).toBe(`refresh-${issued}`)
    })

    it('stays signed in across a restart', async () => {
      await signIn()
      const token = storedRefreshToken()
      vi.resetModules()
      const service = await import('./profile-cloud-service')
      expect(service.getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({
        state: 'connected'
      })
      const store = await import('./profile-cloud-session-store')
      const session = store.readOrcaCloudSession(
        ensureActiveOrcaProfile(userDataPath).profile.id,
        userDataPath
      )
      expect(session.status === 'found' && session.session.refreshToken).toBe(token)
    })
  })

  it('fails sign-in, leaving the profile local, when the session cannot be saved', async () => {
    net.exchange.mockResolvedValueOnce(issue())
    disk.failSessionWrites = 1
    await expect(connectCurrentOrcaProfile(userDataPath)).resolves.toMatchObject({
      status: 'failed'
    })
    expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({ state: 'local' })
  })

  describe('sign-out', () => {
    it('explicit sign-out revokes the session, clears it and unlinks the profile', async () => {
      await signIn()
      const token = storedRefreshToken()
      await expect(signOutCurrentOrcaProfile(userDataPath)).resolves.toMatchObject({
        status: 'signed-out'
      })
      expect(net.revoke).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ refreshToken: token })
      )
      expect(storedRefreshToken()).toBe('missing')
      expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({ state: 'local' })
      await expect(readRelayAuthContext(authConfig(), userDataPath)).resolves.toBeNull()
    })

    it('a server-revoked refresh signs out, notifies, and stops refreshing', async () => {
      await signIn(1_000)
      const invalidated = vi.fn()
      const unsubscribe = onOrcaCloudSessionInvalidated(invalidated)
      net.refresh.mockRejectedValue(new OrcaCloudRequestError(401))

      await expect(readRelayAuthContext(authConfig(), userDataPath)).resolves.toBeNull()
      await expect(readRelayAuthContext(authConfig(), userDataPath)).resolves.toBeNull()

      expect(net.refresh).toHaveBeenCalledTimes(1)
      expect(invalidated).toHaveBeenCalledTimes(1)
      expect(storedRefreshToken()).toBe('missing')
      expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({
        state: 'reconnect-required'
      })
      unsubscribe()
    })

    it('a 403 from refresh also signs out', async () => {
      await signIn(1_000)
      net.refresh.mockRejectedValue(new OrcaCloudRequestError(403))
      await expect(readRelayAuthContext(authConfig(), userDataPath)).resolves.toBeNull()
      expect(storedRefreshToken()).toBe('missing')
    })
  })

  describe('org selection', () => {
    it('switches the active org and keeps the tokens', async () => {
      await signIn()
      const token = storedRefreshToken()
      net.selectOrg.mockResolvedValue({
        cloud: cloud('org-2'),
        organizations: orgs,
        capabilities: { flags: { 'relay.use': true, picked: true }, refreshedAt: Date.now() }
      })
      await expect(selectCurrentOrcaProfileOrg(userDataPath, 'org-2')).resolves.toMatchObject({
        status: 'selected'
      })
      expect(ensureActiveOrcaProfile(userDataPath).profile.cloud?.activeOrgId).toBe('org-2')
      expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({
        state: 'connected',
        capabilities: { flags: { picked: true } }
      })
      expect(storedRefreshToken()).toBe(token)
    })

    it('refreshes once and retries when the select request gets a 401', async () => {
      await signIn()
      const rotated = issue()
      net.refresh.mockResolvedValue(rotated)
      net.selectOrg.mockRejectedValueOnce(new OrcaCloudRequestError(401)).mockResolvedValueOnce({
        cloud: cloud('org-2'),
        organizations: orgs,
        capabilities: { flags: {}, refreshedAt: Date.now() }
      })
      await expect(selectCurrentOrcaProfileOrg(userDataPath, 'org-2')).resolves.toMatchObject({
        status: 'selected'
      })
      expect(net.refresh).toHaveBeenCalledTimes(1)
      expect(net.selectOrg.mock.calls[1][1]).toMatchObject({ accessToken: rotated.accessToken })
      expect(ensureActiveOrcaProfile(userDataPath).profile.cloud?.activeOrgId).toBe('org-2')
      expect(storedRefreshToken()).toBe(rotated.refreshToken)
    })

    it('fails without changing the org when the server picks another identity', async () => {
      await signIn()
      net.selectOrg.mockResolvedValue({
        cloud: { ...cloud('org-2'), userId: 'someone-else' },
        capabilities: { flags: {}, refreshedAt: Date.now() }
      })
      await expect(selectCurrentOrcaProfileOrg(userDataPath, 'org-2')).resolves.toMatchObject({
        status: 'failed'
      })
      expect(ensureActiveOrcaProfile(userDataPath).profile.cloud?.activeOrgId).toBe('org-1')
    })
  })

  describe('capability refresh', () => {
    it('saves new capabilities and keeps the tokens', async () => {
      await signIn()
      const token = storedRefreshToken()
      net.capabilities.mockResolvedValue({
        capabilities: { flags: { fresh: true }, refreshedAt: Date.now() }
      })
      await expect(refreshCurrentOrcaProfileAuth(userDataPath)).resolves.toMatchObject({
        status: 'refreshed'
      })
      expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({
        capabilities: { flags: { fresh: true } }
      })
      expect(storedRefreshToken()).toBe(token)
    })

    it('follows an org change the server reports', async () => {
      await signIn()
      net.capabilities.mockResolvedValue({
        cloud: cloud('org-2'),
        capabilities: { flags: {}, refreshedAt: Date.now() }
      })
      await expect(refreshCurrentOrcaProfileAuth(userDataPath)).resolves.toMatchObject({
        status: 'refreshed'
      })
      expect(ensureActiveOrcaProfile(userDataPath).profile.cloud?.activeOrgId).toBe('org-2')
    })

    it('refuses a capability reply begun before an org switch, even after switching back', async () => {
      await signIn()
      let finish!: (value: unknown) => void
      net.capabilities.mockReturnValue(new Promise((resolve) => (finish = resolve)))
      net.selectOrg.mockImplementation(
        async (_config: unknown, _session: unknown, orgId: string) => ({
          cloud: cloud(orgId),
          organizations: orgs,
          capabilities: { flags: {}, refreshedAt: Date.now() }
        })
      )
      const refreshing = refreshCurrentOrcaProfileAuth(userDataPath)
      await vi.waitFor(() => expect(net.capabilities).toHaveBeenCalled())
      await selectCurrentOrcaProfileOrg(userDataPath, 'org-2')
      await selectCurrentOrcaProfileOrg(userDataPath, 'org-1')
      finish({ cloud: cloud('org-1'), capabilities: { flags: { stale: true }, refreshedAt: 1 } })
      await expect(refreshing).resolves.toMatchObject({ status: 'reconnect-required' })
      expect(getCurrentOrcaProfileAuthStatus(userDataPath)).not.toMatchObject({
        capabilities: { flags: { stale: true } }
      })
    })

    it('refreshes the session first when it is about to expire', async () => {
      await signIn(1_000)
      const rotated = issue()
      net.refresh.mockResolvedValue(rotated)
      net.capabilities.mockResolvedValue({ capabilities: { flags: {}, refreshedAt: Date.now() } })
      await expect(refreshCurrentOrcaProfileAuth(userDataPath)).resolves.toMatchObject({
        status: 'refreshed'
      })
      expect(net.capabilities.mock.calls[0][1]).toMatchObject({
        accessToken: rotated.accessToken
      })
      expect(storedRefreshToken()).toBe(rotated.refreshToken)
    })
  })

  describe('relay auth context and renewal', () => {
    it('returns the stored identity and token without a refresh while fresh', async () => {
      await signIn()
      await expect(readRelayAuthContext(authConfig(), userDataPath)).resolves.toEqual({
        identity: { userId: 'user-1', profileId: 'cloud-profile-1', organizationId: 'org-1' },
        accessToken: `access-${issued}`,
        relayEntitled: true
      })
      expect(net.refresh).not.toHaveBeenCalled()
    })

    it('renews an expiring session once and stores the rotation', async () => {
      await signIn(1_000)
      const rotated = issue()
      net.refresh.mockResolvedValue(rotated)
      const [first, second] = await Promise.all([
        readRelayAuthContext(authConfig(), userDataPath),
        readRelayAuthContext(authConfig(), userDataPath)
      ])
      expect(net.refresh).toHaveBeenCalledTimes(1)
      expect(first?.accessToken).toBe(rotated.accessToken)
      expect(second?.accessToken).toBe(rotated.accessToken)
      expect(storedRefreshToken()).toBe(rotated.refreshToken)
    })

    it('takes the capabilities a renewal returns', async () => {
      await signIn(1_000)
      const rotated = {
        ...issue(),
        capabilities: { flags: { 'relay.use': true, renewed: true }, refreshedAt: Date.now() }
      }
      net.refresh.mockResolvedValue(rotated)
      await readRelayAuthContext(authConfig(), userDataPath)
      expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({
        capabilities: { flags: { renewed: true } }
      })
    })

    it('does not bring a session back when sign-out lands during a renewal', async () => {
      await signIn(1_000)
      let finish!: (value: unknown) => void
      net.refresh.mockReturnValue(new Promise((resolve) => (finish = resolve)))
      const renewing = readRelayAuthContext(authConfig(), userDataPath).catch(() => null)
      await signOutCurrentOrcaProfile(userDataPath)
      finish(issue())
      await renewing
      expect(storedRefreshToken()).toBe('missing')
      expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({ state: 'local' })
    })

    it('reports a profile that is not linked as no context', async () => {
      await expect(readRelayAuthContext(authConfig(), userDataPath)).resolves.toBeNull()
    })

    it('reports a session without the relay entitlement', async () => {
      net.exchange.mockResolvedValueOnce(issue({ relay: false }))
      await connectCurrentOrcaProfile(userDataPath)
      await expect(readRelayAuthContext(authConfig(), userDataPath)).resolves.toMatchObject({
        relayEntitled: false
      })
    })
  })

  describe('artifact and skill cloud auth', () => {
    it('retries an operation once with a refreshed token after a 401', async () => {
      await signIn()
      const rotated = issue()
      net.refresh.mockResolvedValue(rotated)
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new OrcaCloudRequestError(401))
        .mockResolvedValueOnce('done')
      await expect(
        runSkillCloudOperation({ userDataPath, options: {}, operation })
      ).resolves.toEqual({ status: 'ok', value: 'done' })
      expect(operation.mock.calls.map(([token]) => token)).toEqual([
        `access-${issued - 1}`,
        rotated.accessToken
      ])
      expect(storedRefreshToken()).toBe(rotated.refreshToken)
    })

    it('signs out when the refreshed token is also rejected with a 401', async () => {
      await signIn()
      net.refresh.mockResolvedValue(issue())
      const operation = vi.fn().mockRejectedValue(new OrcaCloudRequestError(401))
      await expect(
        runWithFreshOrcaCloudSession(
          authConfig(),
          ensureActiveOrcaProfile(userDataPath),
          userDataPath,
          operation
        )
      ).resolves.toEqual({ status: 'reconnect-required' })
      expect(storedRefreshToken()).toBe('missing')
    })

    it('keeps the session when the refreshed token gets a 403', async () => {
      await signIn()
      const rotated = issue()
      net.refresh.mockResolvedValue(rotated)
      const operation = vi
        .fn()
        .mockRejectedValueOnce(new OrcaCloudRequestError(401))
        .mockRejectedValueOnce(new OrcaCloudRequestError(403))
      await expect(
        runWithFreshOrcaCloudSession(
          authConfig(),
          ensureActiveOrcaProfile(userDataPath),
          userDataPath,
          operation
        )
      ).rejects.toThrow('orca_cloud_request_failed_403')
      expect(storedRefreshToken()).toBe(rotated.refreshToken)
    })

    it('surfaces a non-auth operation failure without touching the session', async () => {
      await signIn()
      const token = storedRefreshToken()
      const operation = vi.fn().mockRejectedValue(new OrcaCloudRequestError(500))
      await expect(
        runSkillCloudOperation({ userDataPath, options: {}, operation })
      ).rejects.toThrow('orca_cloud_request_failed_500')
      expect(net.refresh).not.toHaveBeenCalled()
      expect(storedRefreshToken()).toBe(token)
    })
  })

  describe('profiles', () => {
    it('keeps each profile’s session separate across a profile switch', async () => {
      await signIn()
      const first = ensureActiveOrcaProfile(userDataPath).profile.id
      const firstToken = storedRefreshToken(first)
      const second = createLocalOrcaProfile({ name: 'Second' }, userDataPath).profile.id
      setActiveOrcaProfile(second, userDataPath)
      expect(ensureActiveOrcaProfile(userDataPath).profile.id).toBe(second)
      expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({ state: 'local' })
      await signIn()
      expect(storedRefreshToken(second)).toBe(`refresh-${issued}`)
      expect(storedRefreshToken(first)).toBe(firstToken)
      setActiveOrcaProfile(first, userDataPath)
      expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({ state: 'connected' })
    })
  })

  describe('failures that keep the session', () => {
    it.each([
      ['a 5xx', () => new OrcaCloudRequestError(503)],
      ['a timeout', () => Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
      ['a network error', () => new TypeError('fetch failed')]
    ])('keeps the session on %s', async (_label, failure) => {
      await signIn(1_000)
      const token = storedRefreshToken()
      net.refresh.mockRejectedValue(failure())
      await expect(readRelayAuthContext(authConfig(), userDataPath)).rejects.toBeTruthy()
      expect(storedRefreshToken()).toBe(token)
      expect(getCurrentOrcaProfileAuthStatus(userDataPath)).toMatchObject({ state: 'connected' })
    })

    it('does not resend a token whose refresh timed out, inside the replay window', async () => {
      await signIn(1_000)
      net.refresh.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }))
      await expect(readRelayAuthContext(authConfig(), userDataPath)).rejects.toBeTruthy()
      await expect(readRelayAuthContext(authConfig(), userDataPath)).rejects.toThrow(
        'orca_cloud_refresh_replay_blocked'
      )
      expect(net.refresh).toHaveBeenCalledTimes(1)
    })

    it('retries a definitive 5xx exactly once, then stores the rotation', async () => {
      await signIn(1_000)
      const rotated = issue()
      net.refresh
        .mockRejectedValueOnce(new OrcaCloudRequestError(502))
        .mockResolvedValueOnce(rotated)
      await expect(readRelayAuthContext(authConfig(), userDataPath)).resolves.toMatchObject({
        accessToken: rotated.accessToken
      })
      expect(net.refresh).toHaveBeenCalledTimes(2)
      expect(net.refresh.mock.calls.map((call) => call[1].refreshToken)).toEqual([
        `refresh-${issued - 1}`,
        `refresh-${issued - 1}`
      ])
      expect(storedRefreshToken()).toBe(rotated.refreshToken)
    })

    it('keeps a rotation that one failed save could not store, across renewals and a restart', async () => {
      await signIn(1_000)
      const signedIn = storedRefreshToken()
      const rotated = issue()
      // Grace-window replays return the same rotated child token.
      net.refresh.mockImplementation(async (_config: unknown, session: OrcaCloudSession) => {
        if (session.refreshToken === signedIn) {
          return rotated
        }
        throw new OrcaCloudRequestError(401)
      })
      disk.failSessionWrites = 1
      for (let renewal = 0; renewal < 13; renewal++) {
        await readRelayAuthContext(authConfig(), userDataPath).catch(() => null)
      }
      vi.resetModules()
      const store = await import('./profile-cloud-session-store')
      const session = store.readOrcaCloudSession(
        ensureActiveOrcaProfile(userDataPath).profile.id,
        userDataPath
      )
      expect(session.status === 'found' && session.session.refreshToken).toBe(rotated.refreshToken)
    })

    it('gives up after the one 5xx retry and keeps the session', async () => {
      await signIn(1_000)
      const token = storedRefreshToken()
      net.refresh.mockRejectedValue(new OrcaCloudRequestError(502))
      await expect(readRelayAuthContext(authConfig(), userDataPath)).rejects.toThrow(
        'orca_cloud_request_failed_502'
      )
      expect(net.refresh).toHaveBeenCalledTimes(2)
      expect(storedRefreshToken()).toBe(token)
    })
  })
})
