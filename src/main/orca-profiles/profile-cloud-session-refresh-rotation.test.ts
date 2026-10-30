import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcaCloudAuthConfig } from './profile-cloud-auth-config'
import type * as ProfileCloudClient from './profile-cloud-client'
import type * as SecureFile from '../../shared/secure-file'
import type * as Fs from 'node:fs'
import type * as ProfileIndexStore from './profile-index-store'
import type { ActiveOrcaProfileState } from './profile-index-store'
import type { OrcaCloudSession } from './profile-cloud-session-store'

const { refreshMock, selectOrgMock, linkMock, linked, writeFailure, removeFailure } = vi.hoisted(
  () => {
    const writeFailure: { code: string | null; onlyFile?: string; times?: number } = { code: null }
    const removeFailure: { code: string | null } = { code: null }
    const linked: { cloud: unknown } = { cloud: undefined }
    return {
      refreshMock: vi.fn(),
      selectOrgMock: vi.fn(),
      linkMock: vi.fn(),
      linked,
      writeFailure,
      removeFailure
    }
  }
)

// Simulate Windows antivirus holding a session file open against deletion.
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof Fs>()
  return {
    ...original,
    rmSync: (...args: Parameters<typeof original.rmSync>) => {
      if (removeFailure.code && String(args[0]).endsWith('account-session.json.enc')) {
        throw Object.assign(new Error(`${removeFailure.code}: remove failed`), {
          code: removeFailure.code
        })
      }
      return original.rmSync(...args)
    }
  }
})

vi.mock('electron', () => ({
  safeStorage: {
    decryptString: (value: Buffer) => value.toString('utf-8'),
    encryptString: (value: string) => Buffer.from(value, 'utf-8'),
    isEncryptionAvailable: () => true
  }
}))

vi.mock('../../shared/secure-file', async (importOriginal) => {
  const original = await importOriginal<typeof SecureFile>()
  return {
    ...original,
    writeSecureJsonFile: (path: string, value: unknown) => {
      if (writeFailure.code && (!writeFailure.onlyFile || path.endsWith(writeFailure.onlyFile))) {
        if (writeFailure.times !== undefined && --writeFailure.times <= 0) {
          writeFailure.code = null
        }
        throw Object.assign(new Error(`${writeFailure.code}: write failed`), {
          code: writeFailure.code
        })
      }
      return original.writeSecureJsonFile(path, value)
    }
  }
})

vi.mock('./profile-cloud-client', async (importOriginal) => {
  const original = await importOriginal<typeof ProfileCloudClient>()
  return {
    ...original,
    refreshOrcaCloudSession: refreshMock,
    selectOrcaCloudOrg: selectOrgMock
  }
})

vi.mock('./profile-cloud-index', () => ({ linkOrcaProfileToCloud: linkMock }))

vi.mock('./profile-index-store', async (importOriginal) => ({
  ...(await importOriginal<typeof ProfileIndexStore>()),
  loadOrCreateProfileIndex: () => ({ profiles: [{ id: 'profile-1', cloud: linked.cloud }] }),
  getOrcaProfileListState: () => ({ activeProfileId: 'profile-1', profiles: [] })
}))

import { OrcaCloudRequestError } from './profile-cloud-client'
import { readFreshOrcaCloudSession } from './profile-cloud-session-refresh'
import { selectCloudOrg } from './profile-cloud-org-selection'
import {
  flushUnsavedOrcaCloudSessions,
  getOrcaCloudSessionPath
} from './profile-cloud-session-store'
import {
  beginCloudSessionRelink,
  commitCloudSessionCapabilities,
  readCloudSession,
  signInCloudSession,
  signOutCloudSession,
  takeCloudSessionTicket
} from './profile-cloud-session-owner'

const ROTATION_GRACE_MS = 60_000
const ACCESS_TTL_MS = 600_000
const BROKER_RETRY_MS = 10_000

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the client is mocked, so no endpoint is read.
const config = {} as OrcaCloudAuthConfig
const cloud = {
  userId: 'user-1',
  cloudProfileId: 'cloud-profile-1',
  email: 'user@example.com',
  activeOrgId: 'org-1',
  linkedAt: 1
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: refresh reads only profile.id and profile.cloud.
const active = { profile: { id: 'profile-1', cloud } } as ActiveOrcaProfileState

// Parent tokens return the same child during grace; later reuse revokes the whole family.
function createRotatingAuthServer(now: () => number, reportedCloud = cloud) {
  let generation = 0
  let current = 'refresh-0'
  let parent: { token: string; rotatedAt: number } | null = null
  let revoked = false
  const sent: string[] = []
  const statuses: number[] = []
  const issue = () => ({
    accessToken: `access-${generation}`,
    refreshToken: current,
    expiresAt: now() + ACCESS_TTL_MS,
    organizations: [],
    capabilities: { flags: { 'relay.use': true }, refreshedAt: now() },
    cloud: reportedCloud
  })
  refreshMock.mockImplementation(async (_config: unknown, session: OrcaCloudSession) => {
    sent.push(session.refreshToken)
    if (!revoked && session.refreshToken === current) {
      parent = { token: current, rotatedAt: now() }
      generation++
      current = `refresh-${generation}`
      statuses.push(200)
      return issue()
    }
    if (
      !revoked &&
      parent?.token === session.refreshToken &&
      now() - parent.rotatedAt < ROTATION_GRACE_MS
    ) {
      statuses.push(200)
      return issue()
    }
    revoked = true
    statuses.push(401)
    throw new OrcaCloudRequestError(401)
  })
  return {
    sent,
    statuses,
    get revoked() {
      return revoked
    },
    revoke: () => {
      revoked = true
    }
  }
}

// Match the relay broker’s renewal cadence and swallowed failures.
async function runBrokerRenewals(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await readFreshOrcaCloudSession(config, active, userDataPath).catch(() => undefined)
    vi.advanceTimersByTime(BROKER_RETRY_MS)
  }
}

function signIn(): void {
  signInCloudSession('profile-1', userDataPath, {
    accessToken: 'access-0',
    refreshToken: 'refresh-0',
    expiresAt: Date.now() + 1_000,
    organizations: [],
    capabilities: { flags: { 'relay.use': true }, refreshedAt: Date.now() },
    cloud
  })
}

async function restart() {
  vi.resetModules()
  return {
    owner: await import('./profile-cloud-session-owner'),
    refresh: await import('./profile-cloud-session-refresh')
  }
}

let userDataPath = ''

describe('cloud session refresh-token rotation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-refresh-rotation-'))
    writeFailure.code = null
    writeFailure.onlyFile = undefined
    writeFailure.times = undefined
    removeFailure.code = null
    refreshMock.mockReset()
    selectOrgMock.mockReset()
    linkMock.mockReset()
    linked.cloud = cloud
    linkMock.mockImplementation((_profileId: string, next: unknown) => {
      linked.cloud = next
      return { activeProfileId: 'profile-1', profiles: [] }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('keeps a rotated token when the session file cannot be written, so it is never replayed', async () => {
    const server = createRotatingAuthServer(Date.now)
    signIn()
    writeFailure.code = 'ENOSPC'

    await runBrokerRenewals(12)

    expect(server.revoked).toBe(false)
    expect(server.sent).toEqual(['refresh-0'])
    const stored = readCloudSession('profile-1', userDataPath)
    expect(stored.status === 'found' && stored.session.refreshToken).toBe('refresh-1')
    expect(existsSync(getOrcaCloudSessionPath('profile-1', userDataPath))).toBe(false)
  })

  it('keeps an unsaved rotation when a later capability save also fails', async () => {
    const server = createRotatingAuthServer(Date.now)
    signIn()
    Object.assign(writeFailure, { code: 'EPERM', onlyFile: 'account-session.json.enc' })

    for (let renewal = 0; renewal < 12; renewal++) {
      await readFreshOrcaCloudSession(config, active, userDataPath).catch(() => undefined)
      expect(() =>
        commitCloudSessionCapabilities(
          'profile-1',
          userDataPath,
          takeCloudSessionTicket('profile-1', userDataPath),
          {
            capabilities: { flags: { 'relay.use': true }, refreshedAt: Date.now() }
          }
        )
      ).toThrow('EPERM')
      vi.advanceTimersByTime(BROKER_RETRY_MS)
    }

    expect(server.sent).toEqual(['refresh-0'])
    expect(server.revoked).toBe(false)
  })

  it('ends the renewal loop on a 401 even when the revocation cannot be written', async () => {
    const server = createRotatingAuthServer(Date.now)
    signIn()
    server.revoke()
    const ticketBeforeRevocation = takeCloudSessionTicket('profile-1', userDataPath)
    writeFailure.code = 'ENOSPC'

    await expect(readFreshOrcaCloudSession(config, active, userDataPath)).resolves.toEqual({
      status: 'reconnect-required'
    })
    await runBrokerRenewals(10)

    expect(server.sent).toEqual(['refresh-0'])
    expect(readCloudSession('profile-1', userDataPath).status).toBe('missing')
    expect(
      commitCloudSessionCapabilities('profile-1', userDataPath, ticketBeforeRevocation, {
        capabilities: { flags: {}, refreshedAt: 1 }
      })
    ).toBeNull()
    expect(readCloudSession('profile-1', userDataPath).status).toBe('missing')
  })

  it('ends the renewal loop on a 401 even when the session file cannot be removed', async () => {
    const server = createRotatingAuthServer(Date.now)
    signIn()
    server.revoke()
    removeFailure.code = 'EBUSY'

    await expect(readFreshOrcaCloudSession(config, active, userDataPath)).resolves.toEqual({
      status: 'reconnect-required'
    })
    await runBrokerRenewals(10)

    expect(server.sent).toEqual(['refresh-0'])
    expect(readCloudSession('profile-1', userDataPath).status).toBe('missing')
  })

  it('keeps a rotated token when an org switch began mid-refresh', async () => {
    const server = createRotatingAuthServer(Date.now)
    signIn()
    const respond = refreshMock.getMockImplementation()!
    refreshMock.mockImplementationOnce(async (...args: [unknown, OrcaCloudSession]) => {
      beginCloudSessionRelink('profile-1', userDataPath)
      return respond(...args)
    })

    await runBrokerRenewals(12)

    expect(server.revoked).toBe(false)
    expect(server.sent).toEqual(['refresh-0'])
    const stored = readCloudSession('profile-1', userDataPath)
    expect(stored.status === 'found' && stored.session.refreshToken).toBe('refresh-1')
  })

  it('does not write spent tokens back when a refresh rotates during org selection', async () => {
    const server = createRotatingAuthServer(Date.now)
    signIn()
    let resolveSelect!: (value: unknown) => void
    selectOrgMock.mockReturnValue(new Promise((resolve) => (resolveSelect = resolve)))
    const selecting = selectCloudOrg({
      config,
      active,
      userDataPath,
      orgId: 'org-2'
    })
    await readFreshOrcaCloudSession(config, active, userDataPath)
    resolveSelect({
      cloud: { ...cloud, activeOrgId: 'org-2' },
      organizations: [],
      capabilities: { flags: { 'relay.use': true }, refreshedAt: Date.now() }
    })
    await selecting

    const stored = readCloudSession('profile-1', userDataPath)
    expect(stored.status === 'found' && stored.session.refreshToken).toBe('refresh-1')
    expect(server.revoked).toBe(false)
  })

  it('refreshes through the shared single-flight when org selection gets a 401', async () => {
    const server = createRotatingAuthServer(Date.now)
    signIn()
    selectOrgMock.mockRejectedValueOnce(new OrcaCloudRequestError(401)).mockResolvedValueOnce({
      cloud: { ...cloud, activeOrgId: 'org-2' },
      organizations: [],
      capabilities: { flags: { 'relay.use': true }, refreshedAt: Date.now() }
    })
    const selecting = selectCloudOrg({
      config,
      active,
      userDataPath,
      orgId: 'org-2'
    })
    const renewing = readFreshOrcaCloudSession(config, active, userDataPath)
    await Promise.all([selecting, renewing])

    expect(server.sent).toEqual(['refresh-0'])
    const stored = readCloudSession('profile-1', userDataPath)
    expect(stored.status === 'found' && stored.session.refreshToken).toBe('refresh-1')
  })

  it('relinks to the org the server reports when nothing relinked meanwhile', async () => {
    createRotatingAuthServer(Date.now, { ...cloud, activeOrgId: 'org-2' })
    signIn()

    await readFreshOrcaCloudSession(config, active, userDataPath)

    expect(linkMock).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({ activeOrgId: 'org-2' }),
      userDataPath
    )
    const stored = readCloudSession('profile-1', userDataPath)
    expect(stored.status === 'found' && stored.session.refreshToken).toBe('refresh-1')
  })

  it('saves the rotated tokens even when relinking to a server-reported org fails', async () => {
    const server = createRotatingAuthServer(Date.now, { ...cloud, activeOrgId: 'org-2' })
    signIn()
    linkMock.mockImplementation(() => {
      throw new Error('EBUSY: profile index locked')
    })

    await runBrokerRenewals(12)

    expect(server.sent).toEqual(['refresh-0'])
    expect(server.revoked).toBe(false)
    const stored = readCloudSession('profile-1', userDataPath)
    expect(stored.status === 'found' && stored.session.refreshToken).toBe('refresh-1')
  })

  it('refuses a capability reply begun before the org moved, even after it moved back', async () => {
    signIn()
    const ticket = takeCloudSessionTicket('profile-1', userDataPath)
    for (const orgId of ['org-2', 'org-1']) {
      commitCloudSessionCapabilities(
        'profile-1',
        userDataPath,
        takeCloudSessionTicket('profile-1', userDataPath),
        {
          cloud: { ...cloud, activeOrgId: orgId },
          capabilities: { flags: {}, refreshedAt: Date.now() }
        }
      )
    }

    expect(
      commitCloudSessionCapabilities('profile-1', userDataPath, ticket, {
        cloud,
        capabilities: { flags: { stale: true }, refreshedAt: Date.now() }
      })
    ).toBeNull()
  })

  it('still accepts a later capability update after a failed relink', async () => {
    createRotatingAuthServer(Date.now, { ...cloud, activeOrgId: 'org-2' })
    signIn()
    linkMock.mockImplementationOnce(() => {
      throw new Error('EBUSY: profile index locked')
    })

    await readFreshOrcaCloudSession(config, active, userDataPath)

    expect(
      commitCloudSessionCapabilities(
        'profile-1',
        userDataPath,
        takeCloudSessionTicket('profile-1', userDataPath),
        { capabilities: { flags: { 'relay.use': true }, refreshedAt: Date.now() } }
      )
    ).not.toBeNull()
  })

  it('fails a non-rotating save as before and keeps the still-valid session file', async () => {
    signIn()
    selectOrgMock.mockResolvedValue({
      cloud: { ...cloud, activeOrgId: 'org-2' },
      organizations: [],
      capabilities: { flags: { 'relay.use': true }, refreshedAt: Date.now() }
    })
    writeFailure.code = 'ENOSPC'
    writeFailure.onlyFile = 'account-session.json.enc'

    await expect(selectCloudOrg({ config, active, userDataPath, orgId: 'org-2' })).rejects.toThrow(
      'ENOSPC'
    )

    expect(existsSync(getOrcaCloudSessionPath('profile-1', userDataPath))).toBe(true)
  })

  it('reports org selection as done when the link already moved to the selected org', async () => {
    signIn()
    let resolveSelect!: (value: unknown) => void
    selectOrgMock.mockReturnValue(new Promise((resolve) => (resolveSelect = resolve)))
    const reply = {
      cloud: { ...cloud, activeOrgId: 'org-2' },
      organizations: [],
      capabilities: { flags: { 'relay.use': true }, refreshedAt: Date.now() }
    }
    const selecting = selectCloudOrg({ config, active, userDataPath, orgId: 'org-2' })
    commitCloudSessionCapabilities(
      'profile-1',
      userDataPath,
      takeCloudSessionTicket('profile-1', userDataPath),
      reply
    )
    resolveSelect(reply)

    await expect(selecting).resolves.not.toBeNull()
    expect(linked.cloud).toMatchObject({ activeOrgId: 'org-2' })
  })

  it('keeps a rotation that one failed write could not store, across renewals and a restart', async () => {
    const server = createRotatingAuthServer(Date.now)
    signIn()
    Object.assign(writeFailure, { code: 'EBUSY', onlyFile: 'account-session.json.enc', times: 1 })

    await runBrokerRenewals(13)
    const { owner } = await restart()

    expect(server.sent).toEqual(['refresh-0'])
    const stored = owner.readCloudSession('profile-1', userDataPath)
    expect(stored.status === 'found' && stored.session.refreshToken).toBe('refresh-1')
  })

  it('writes the latest token at quit once the write and the stale-file delete stop failing', async () => {
    createRotatingAuthServer(Date.now)
    signIn()
    Object.assign(writeFailure, { code: 'EBUSY', onlyFile: 'account-session.json.enc' })
    removeFailure.code = 'EBUSY'

    await runBrokerRenewals(1)
    writeFailure.code = null
    removeFailure.code = null
    flushUnsavedOrcaCloudSessions()
    const { owner } = await restart()

    const stored = owner.readCloudSession('profile-1', userDataPath)
    expect(stored.status === 'found' && stored.session.refreshToken).toBe('refresh-1')
  })

  it('asks for sign-in after a restart when the rotation could never be saved, without a loop', async () => {
    const server = createRotatingAuthServer(Date.now)
    signIn()
    Object.assign(writeFailure, { code: 'ENOSPC', onlyFile: 'account-session.json.enc' })

    await runBrokerRenewals(3)
    flushUnsavedOrcaCloudSessions()
    const { refresh } = await restart()
    for (let renewal = 0; renewal < 3; renewal++) {
      await expect(
        refresh.readFreshOrcaCloudSession(config, active, userDataPath)
      ).resolves.toEqual({ status: 'reconnect-required' })
    }

    expect(server.sent).toEqual(['refresh-0'])
    expect(server.revoked).toBe(false)
  })

  it('still discards a rotation that lands after sign-out', async () => {
    createRotatingAuthServer(Date.now)
    signIn()
    const respond = refreshMock.getMockImplementation()!
    refreshMock.mockImplementationOnce(async (...args: [unknown, OrcaCloudSession]) => {
      signOutCloudSession('profile-1', userDataPath)
      return respond(...args)
    })

    await expect(readFreshOrcaCloudSession(config, active, userDataPath)).rejects.toThrow(
      'stale_cloud_session_mutation'
    )
    expect(readCloudSession('profile-1', userDataPath).status).toBe('missing')
    expect(existsSync(getOrcaCloudSessionPath('profile-1', userDataPath))).toBe(false)
  })

  it('keeps the session on a 5xx', async () => {
    refreshMock.mockRejectedValue(new OrcaCloudRequestError(503))
    signIn()
    writeFailure.code = 'ENOSPC'

    await expect(readFreshOrcaCloudSession(config, active, userDataPath)).rejects.toThrow(
      'orca_cloud_request_failed_503'
    )
    expect(readCloudSession('profile-1', userDataPath).status).toBe('found')
  })
})
