import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaProfileAuthStatus } from '../../shared/orca-profiles/orca-profiles'
import { setSecretStore } from '../../shared/secure-storage/secret-store'
import type { OrcaAccountSignInStatus } from '../../shared/orca-account-server-sign-in'
import { OrcaServerSignIn } from './orca-server-sign-in'
import type {
  ServerSignInPollResult,
  ServerSignInRequestBody
} from './orca-cloud-server-sign-in-requests'
import { supersedeCloudConnectAttempts } from './cloud-auth/profile-cloud-connect-attempts'
import type { OrcaCloudAuthorizationCode } from './cloud-auth/profile-cloud-pkce'

const ENV = {
  ORCA_CLOUD_API_URL: 'https://login.example.test',
  ORCA_CLOUD_CLIENT_ID: 'orca-desktop',
  ORCA_RELAY_URL: 'https://relay.example.test'
}
const CLAIM_TOKEN = 'claim-secret-6f1c'
const REDIRECT = 'https://login.example.test/v1/server-sign-in/verify?request=req-1'

const signedOut: OrcaProfileAuthStatus = {
  activeProfileId: 'profile-1',
  configured: true,
  state: 'local',
  persistence: 'none'
}

/** A host whose Orca Cloud answers each poll from `answers`; an empty list keeps it pending. */
function approvalHost(
  answers: ServerSignInPollResult[],
  options: { verificationUrl?: string } = {}
) {
  const sent: ServerSignInRequestBody[] = []
  const signInWithCode = vi.fn(
    async (_config: unknown, _code: OrcaCloudAuthorizationCode, _guards?: unknown) => ({
      status: 'connected' as const,
      auth: signedOut,
      activeProfileId: 'profile-1',
      profiles: []
    })
  )
  const poll = vi.fn(async () => answers.shift() ?? { status: 'pending' as const })
  const closeRequest = vi.fn(async () => undefined)
  let requests = 0
  const server = new OrcaServerSignIn({
    account: {
      getAuthStatus: () => signedOut,
      signInWithCode,
      selectOrg: vi.fn(),
      signOut: vi.fn(),
      refreshAuth: vi.fn()
    },
    probe: async () => true,
    env: ENV,
    machineLabel: () => 'devbox',
    platform: 'linux',
    startRequest: async (_config, body) => {
      sent.push(body)
      requests++
      return {
        requestId: `req-${requests}`,
        claimToken: CLAIM_TOKEN,
        userCode: 'WDJB-MJHT',
        verificationUrl: options.verificationUrl ?? 'https://login.example.test/device',
        intervalSeconds: 5,
        expiresInSeconds: 600
      }
    },
    closeRequest,
    approval: {
      poll,
      now: () => 0,
      // Real time never passes; each poll waits one macrotask so cancels can land between them.
      sleep: (_ms, signal) =>
        new Promise((resolve) => {
          signal.throwIfAborted()
          setImmediate(resolve)
        })
    }
  })
  return { server, sent, poll, signInWithCode, closeRequest }
}

async function settled(
  server: OrcaServerSignIn,
  start: OrcaAccountSignInStatus,
  seen: OrcaAccountSignInStatus[]
): Promise<OrcaAccountSignInStatus> {
  let status = start
  seen.push(status)
  while (!['signedIn', 'failed', 'cancelled'].includes(status.phase)) {
    status = await server.waitSignIn('cli', start.flowId, status.revision)
    seen.push(status)
  }
  return status
}

let servers: OrcaServerSignIn[] = []

describe('approve-in-browser sign-in', () => {
  beforeEach(() => {
    servers = []
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (cipher) => cipher.toString(),
      describeProtectionGap: () => null,
      describeSealing: () => ({ kind: 'os-keychain' })
    })
  })

  afterEach(() => {
    for (const server of servers) {
      server.dispose()
    }
    vi.restoreAllMocks()
  })

  it('shows the link and code, then finishes on its own with the host-held verifier', async () => {
    const logs: unknown[] = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void logs.push(...args))
    }
    const host = approvalHost([
      { status: 'pending' },
      { status: 'approved', code: 'one-time', redirectUri: REDIRECT }
    ])
    servers.push(host.server)
    const seen: OrcaAccountSignInStatus[] = []

    const start = host.server.startSignIn('cli', 'sign-in', { approveInBrowser: true })
    const done = await settled(host.server, start, seen)

    expect(seen.find((status) => status.phase === 'waiting')?.prompt).toEqual({
      kind: 'approve-in-browser',
      verificationUrl: 'https://login.example.test/device',
      userCode: 'WDJB-MJHT',
      machineLabel: 'devbox',
      expiresAt: 600_000
    })
    expect(done).toMatchObject({ phase: 'signedIn', provider: 'sign-in' })
    const [, code] = host.signInWithCode.mock.calls[0] ?? []
    expect(code).toMatchObject({
      code: 'one-time',
      redirectUri: REDIRECT,
      state: host.sent[0]?.state
    })
    expect(
      createHash('sha256')
        .update(code?.codeVerifier ?? '')
        .digest('base64url')
    ).toBe(host.sent[0]?.codeChallenge)
    expect(JSON.stringify(host.sent)).not.toContain(code?.codeVerifier)
    // The claim token stays in the host: no status a client receives and no log line carries it.
    expect(JSON.stringify(seen)).not.toContain(CLAIM_TOKEN)
    expect(JSON.stringify(logs)).not.toContain(CLAIM_TOKEN)
  })

  it('accepts no pasted code', async () => {
    const host = approvalHost([])
    servers.push(host.server)
    const start = host.server.startSignIn('cli', 'sign-in', { approveInBrowser: true })
    await settledUntilWaiting(host.server, start)

    expect(() =>
      host.server.completeSignIn('cli', start.flowId, {
        code: 'pasted',
        state: 'anything',
        redirectUri: 'https://login.example.test/v1/desktop/auth/server-sign-in/code'
      })
    ).toThrow()
    await host.server.cancelSignIn('cli', start.flowId)
  })

  it('stops asking Orca Cloud when cancelled mid-wait', async () => {
    const host = approvalHost([])
    servers.push(host.server)
    const start = host.server.startSignIn('cli', 'sign-in', { approveInBrowser: true })
    await settledUntilWaiting(host.server, start)
    await vi.waitFor(() => expect(host.poll).toHaveBeenCalled())

    const cancelled = await host.server.cancelSignIn('cli', start.flowId)
    const polls = host.poll.mock.calls.length
    await new Promise((resolve) => setImmediate(resolve))

    expect(cancelled.phase).toBe('cancelled')
    expect(host.poll).toHaveBeenCalledTimes(polls)
    expect(host.signInWithCode).not.toHaveBeenCalled()
  })

  it('lets another device replace a sign-in waiting on approval, and closes the old request', async () => {
    const host = approvalHost([])
    servers.push(host.server)
    const first = host.server.startSignIn('device-a', 'sign-in', { approveInBrowser: true })
    const waiting = await settledUntilWaiting(host.server, first, 'device-a')

    const second = host.server.startSignIn('device-b', 'sign-in', { approveInBrowser: true })

    expect(second.flowId).not.toBe(first.flowId)
    await expect(
      host.server.waitSignIn('device-a', first.flowId, waiting.revision)
    ).resolves.toMatchObject({
      phase: 'cancelled'
    })
    await vi.waitFor(() =>
      expect(host.closeRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ requestId: 'req-1', claimToken: CLAIM_TOKEN })
      )
    )
    await settledUntilWaiting(host.server, second, 'device-b')
    await host.server.cancelSignIn('device-b', second.flowId)
  })

  it('stops when the host switches Orca profiles mid-wait', async () => {
    const host = approvalHost([])
    servers.push(host.server)
    const start = host.server.startSignIn('cli', 'sign-in', { approveInBrowser: true })
    await settledUntilWaiting(host.server, start)

    supersedeCloudConnectAttempts()
    const done = await settled(host.server, start, [])

    expect(done).toMatchObject({
      phase: 'failed',
      error: 'The account on this host changed during sign-in. Start again.'
    })
    expect(host.signInWithCode).not.toHaveBeenCalled()
  })

  it('reports a declined approval', async () => {
    const host = approvalHost([{ status: 'denied' }])
    servers.push(host.server)

    const start = host.server.startSignIn('cli', 'sign-in', { approveInBrowser: true })

    await expect(settled(host.server, start, [])).resolves.toMatchObject({
      phase: 'failed',
      error: 'The sign-in was declined in the browser.'
    })
  })

  it('refuses to show a link that is not on its own Orca Cloud', async () => {
    const host = approvalHost([], { verificationUrl: 'https://phish.example.test/device' })
    servers.push(host.server)

    const start = host.server.startSignIn('cli', 'sign-in', { approveInBrowser: true })
    const seen: OrcaAccountSignInStatus[] = []

    await expect(settled(host.server, start, seen)).resolves.toMatchObject({
      phase: 'failed',
      error: 'Orca Cloud sent a sign-in link for another site. Start again.'
    })
    expect(JSON.stringify(seen)).not.toContain('phish.example.test')
  })

  it('still gives a paste-back prompt to clients that do not ask for approval', async () => {
    const host = approvalHost([])
    servers.push(host.server)
    const start = host.server.startSignIn('desktop', 'sign-in')
    const waiting = await settledUntilWaiting(host.server, start, 'desktop')

    expect(waiting.prompt).toMatchObject({
      clientId: 'orca-server',
      hostedCodePageUrl: expect.any(String)
    })
    expect(host.sent).toEqual([])
    await host.server.cancelSignIn('desktop', start.flowId)
  })
})

async function settledUntilWaiting(
  server: OrcaServerSignIn,
  start: OrcaAccountSignInStatus,
  owner = 'cli'
): Promise<OrcaAccountSignInStatus> {
  let status = start
  while (status.phase === 'starting') {
    status = await server.waitSignIn(owner, start.flowId, status.revision)
  }
  return status
}
