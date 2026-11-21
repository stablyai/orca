import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaProfileAuthStatus } from '../../shared/orca-profiles/orca-profiles'
import { setSecretStore, type SecretSealing } from '../../shared/secure-storage/secret-store'
import type {
  OrcaAccountAuthorizeRequest,
  OrcaAccountSignInStatus
} from '../../shared/orca-account-server-sign-in'
import {
  buildOrcaAccountAuthorizeUrl,
  isOrcaAccountApprovalPrompt
} from '../../shared/orca-account-server-sign-in'
import { OrcaServerSignIn, type OrcaServerSignInDeps } from './orca-server-sign-in'
import { probeOrcaServerSignIn } from './orca-cloud-server-sign-in-probe'
import type { OrcaCloudAuthConfig } from './cloud-auth/profile-cloud-auth-config'
import type { OrcaCloudAuthorizationCode } from './cloud-auth/profile-cloud-pkce'

const ENV = {
  ORCA_CLOUD_API_URL: 'https://login.example.test',
  ORCA_CLOUD_CLIENT_ID: 'orca-desktop'
}

function signedOut(): OrcaProfileAuthStatus {
  return { activeProfileId: 'profile-1', configured: true, state: 'local', persistence: 'none' }
}

function signedIn(): OrcaProfileAuthStatus {
  return {
    activeProfileId: 'profile-1',
    configured: true,
    state: 'connected',
    persistence: 'encrypted',
    cloud: {
      cloudProfileId: 'cp-1',
      userId: 'u-1',
      email: 'person@example.test',
      activeOrgId: 'org-1',
      activeOrgName: 'Acme',
      linkedAt: 1
    },
    capabilities: { flags: {}, refreshedAt: 42 }
  }
}

function installSealing(sealing: SecretSealing): void {
  setSecretStore({
    isEncryptionAvailable: () => sealing.kind !== 'none',
    encryptString: (value) => Buffer.from(value),
    decryptString: (cipher) => cipher.toString(),
    describeProtectionGap: () => null,
    describeSealing: () => sealing
  })
}

function harness(overrides: Partial<OrcaServerSignInDeps> = {}) {
  let auth = signedOut()
  const account = {
    getAuthStatus: vi.fn(() => auth),
    signInWithCode: vi.fn(
      async (
        _config: unknown,
        _code: OrcaCloudAuthorizationCode,
        _guards?: { signal?: AbortSignal; requireSealedStorage?: boolean }
      ): Promise<
        | {
            status: 'connected'
            auth: OrcaProfileAuthStatus
            activeProfileId: string
            profiles: []
          }
        | { status: 'cancelled'; auth: OrcaProfileAuthStatus }
      > => {
        auth = signedIn()
        return { status: 'connected', auth, activeProfileId: 'profile-1', profiles: [] }
      }
    ),
    selectOrg: vi.fn(),
    signOut: vi.fn(async () => {
      auth = signedOut()
      return { status: 'signed-out' as const, auth, activeProfileId: 'profile-1', profiles: [] }
    }),
    refreshAuth: vi.fn()
  }
  const probe = vi.fn(async () => true)
  const server = new OrcaServerSignIn({
    account,
    probe,
    env: ENV,
    machineLabel: () => 'build-box',
    platform: 'linux',
    ...overrides
  })
  return {
    server,
    account,
    probe,
    setAuth: (next: OrcaProfileAuthStatus) => {
      auth = next
    }
  }
}

async function settledOrPrompt(
  server: OrcaServerSignIn,
  owner: string,
  started: OrcaAccountSignInStatus
): Promise<OrcaAccountSignInStatus> {
  let status = started
  while (status.phase === 'starting') {
    status = await server.waitSignIn(owner, started.flowId, status.revision)
  }
  return status
}

function promptOf(status: OrcaAccountSignInStatus): OrcaAccountAuthorizeRequest {
  if (!status.prompt || isOrcaAccountApprovalPrompt(status.prompt)) {
    throw new Error(`no paste-back prompt in phase ${status.phase}`)
  }
  return status.prompt
}

let servers: OrcaServerSignIn[] = []

describe('OrcaServerSignIn', () => {
  beforeEach(() => {
    installSealing({ kind: 'os-keychain' })
    servers = []
  })

  afterEach(() => {
    for (const server of servers) {
      server.dispose()
    }
  })

  function track<T extends { server: OrcaServerSignIn }>(value: T): T {
    servers.push(value.server)
    return value
  }

  it('hands the client the authorize request and keeps the verifier', async () => {
    const { server, account } = track(harness())
    const started = server.startSignIn('device-a', 'sign-in')
    const waiting = await settledOrPrompt(server, 'device-a', started)

    expect(waiting.phase).toBe('waiting')
    const prompt = promptOf(waiting)
    expect(prompt).toMatchObject({
      authorizeOrigin: 'https://login.example.test',
      clientId: 'orca-server',
      codeChallengeMethod: 'S256',
      localProfileId: 'profile-1',
      machineLabel: 'build-box',
      machinePlatform: 'linux',
      hostedCodePageUrl: 'https://login.example.test/v1/desktop/auth/server-sign-in/code'
    })
    expect(JSON.stringify(prompt)).not.toContain('codeVerifier')
    const link = new URL(buildOrcaAccountAuthorizeUrl(prompt, prompt.hostedCodePageUrl, 'terminal'))
    expect(link.searchParams.get('client_id')).toBe('orca-server')
    expect(link.searchParams.get('sign_in_from')).toBe('terminal')

    server.completeSignIn('device-a', started.flowId, {
      code: 'one-time',
      state: prompt.state,
      redirectUri: prompt.hostedCodePageUrl
    })
    const done = await server.waitSignIn('device-a', started.flowId, 0)
    const finished =
      done.phase === 'signedIn'
        ? done
        : await server.waitSignIn('device-a', started.flowId, done.revision)

    expect(finished.phase).toBe('signedIn')
    expect(finished.account).toMatchObject({ state: 'signed-in', email: 'person@example.test' })
    const redeemed = account.signInWithCode.mock.calls[0]?.[1]
    expect(redeemed).toMatchObject({ code: 'one-time', state: prompt.state })
    const challenge = createHash('sha256')
      .update(redeemed?.codeVerifier ?? '')
      .digest('base64url')
    expect(challenge).toBe(prompt.codeChallenge)
  })

  it('refuses a code whose state belongs to another sign-in', async () => {
    const { server, account } = track(harness())
    const started = server.startSignIn('device-a', 'sign-in')
    const waiting = await settledOrPrompt(server, 'device-a', started)

    server.completeSignIn('device-a', started.flowId, {
      code: 'one-time',
      state: 'someone-elses-state',
      redirectUri: promptOf(waiting).hostedCodePageUrl
    })
    let status = await server.waitSignIn('device-a', started.flowId, 0)
    while (status.phase === 'verifying') {
      status = await server.waitSignIn('device-a', started.flowId, status.revision)
    }

    expect(status).toMatchObject({
      phase: 'failed',
      error: 'That code belongs to a different sign-in. Start again.'
    })
    expect(account.signInWithCode).not.toHaveBeenCalled()
  })

  it('stops before any link when Orca Cloud does not support server sign-in', async () => {
    const { server } = track(harness({ probe: async () => false }))
    const started = server.startSignIn('device-a', 'sign-in')
    const status = await settledOrPrompt(server, 'device-a', started)

    expect(status).toMatchObject({
      phase: 'failed',
      error: "Orca Cloud doesn't support server sign-in yet."
    })
    expect(status.prompt).toBeUndefined()
  })

  it('refuses storage that is not sealed and allows the host-key seal with its warning', async () => {
    installSealing({ kind: 'none', reason: 'credentials are stored unencrypted.' })
    const refused = track(harness())
    const started = refused.server.startSignIn('device-a', 'sign-in')
    await expect(settledOrPrompt(refused.server, 'device-a', started)).resolves.toMatchObject({
      phase: 'failed',
      error: "Orca can't save your sign-in on this server: credentials are stored unencrypted."
    })
    expect(refused.probe).not.toHaveBeenCalled()

    installSealing({ kind: 'host-key', warning: 'Anyone who can read this account can unseal.' })
    const allowed = track(harness())
    expect(allowed.server.status().storage).toEqual({
      kind: 'host-key',
      warning: 'Anyone who can read this account can unseal.'
    })
    const next = allowed.server.startSignIn('device-a', 'sign-in')
    await expect(settledOrPrompt(allowed.server, 'device-a', next)).resolves.toMatchObject({
      phase: 'waiting'
    })
  })

  it('keeps one pending sign-in per server, owned by the device that started it', async () => {
    const { server } = track(harness())
    const started = server.startSignIn('device-a', 'sign-in')

    expect(() => server.startSignIn('device-b', 'sign-in')).toThrow(
      'Another device is signing this server in. Finish or cancel it there first.'
    )
    await expect(server.waitSignIn('device-b', started.flowId, 0)).rejects.toThrow(
      'This sign-in is no longer active in this client.'
    )
    expect(server.startSignIn('device-a', 'sign-in').flowId).toBe(started.flowId)
  })

  it('refuses a plain sign-in while signed in and leaves the switch decision to commit time', async () => {
    const { server, setAuth } = track(harness())
    setAuth(signedIn())

    const plain = server.startSignIn('device-a', 'sign-in')
    await expect(settledOrPrompt(server, 'device-a', plain)).resolves.toMatchObject({
      phase: 'failed',
      error: 'This server is already signed in. Use Switch account to change it.'
    })
    const switching = server.startSignIn('device-a', 'switch-account')
    await expect(settledOrPrompt(server, 'device-a', switching)).resolves.toMatchObject({
      phase: 'waiting'
    })
  })

  it('commits with strict sealed storage and the flow signal, and a cancel during the exchange wins', async () => {
    const exchange = Promise.withResolvers<void>()
    const { server, account } = track(harness())
    account.signInWithCode.mockImplementation(async (_config, _code, guards) => {
      await exchange.promise
      return guards?.signal?.aborted
        ? { status: 'cancelled' as const, auth: signedOut() }
        : { status: 'connected' as const, auth: signedIn(), activeProfileId: 'p', profiles: [] }
    })
    const started = server.startSignIn('device-a', 'sign-in')
    const waiting = await settledOrPrompt(server, 'device-a', started)
    server.completeSignIn('device-a', started.flowId, {
      code: 'one-time',
      state: promptOf(waiting).state,
      redirectUri: promptOf(waiting).hostedCodePageUrl
    })
    await vi.waitFor(() => expect(account.signInWithCode).toHaveBeenCalled())

    const cancelling = server.cancelSignIn('device-a', started.flowId)
    exchange.resolve()

    await expect(cancelling).resolves.toMatchObject({ phase: 'cancelled' })
    expect(account.signInWithCode.mock.calls[0]?.[2]).toMatchObject({ requireSealedStorage: true })
    expect(account.signInWithCode.mock.calls[0]?.[2]?.signal?.aborted).toBe(true)
  })

  it('cancels the pending sign-in and publishes signed-out status', async () => {
    const { server, account } = track(harness())
    const started = server.startSignIn('device-a', 'sign-in')
    await settledOrPrompt(server, 'device-a', started)
    const seen: string[] = []
    server.onChanged((status) => seen.push(status.state))

    const status = await server.signOut()

    expect(status.state).toBe('signed-out')
    expect(seen).toEqual(['signed-out'])
    expect(account.signOut).toHaveBeenCalledTimes(1)
    await expect(server.waitSignIn('device-a', started.flowId, 0)).resolves.toMatchObject({
      phase: 'cancelled'
    })
  })

  it('refreshes once a day only while signed in', async () => {
    vi.useFakeTimers()
    try {
      const { server, account, setAuth } = track(harness())
      account.refreshAuth.mockResolvedValue({ status: 'refreshed' })
      server.startDailyRefresh()

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
      expect(account.refreshAuth).not.toHaveBeenCalled()

      setAuth(signedIn())
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
      expect(account.refreshAuth).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('probeOrcaServerSignIn', () => {
  afterEach(() => vi.unstubAllGlobals())

  const config = {
    apiBaseUrl: 'https://login.example.test'
  } satisfies Pick<OrcaCloudAuthConfig, 'apiBaseUrl'>

  it.each([
    [200, true],
    [404, false]
  ])('reads %i as supported=%s', async (status, supported) => {
    const fetchMock = vi.fn(async (_url: URL) => new Response(null, { status }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(probeOrcaServerSignIn(config, 'orca-server')).resolves.toBe(supported)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://login.example.test/v1/desktop/auth/clients/orca-server'
    )
  })

  it('reports other answers and network failures instead of guessing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 }))
    )
    await expect(probeOrcaServerSignIn(config, 'orca-server')).rejects.toThrow(
      'Orca Cloud answered 503'
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline')
      })
    )
    await expect(probeOrcaServerSignIn(config, 'orca-server')).rejects.toThrow(
      "Couldn't reach Orca Cloud"
    )
  })
})
