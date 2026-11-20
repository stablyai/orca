import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch/dispatch'
import type { RuntimeClient } from '../runtime/client'
import type {
  OrcaAccountApprovalPrompt,
  OrcaAccountServerStatus
} from '../../shared/orca-account-server-sign-in'
import { AUTH_HANDLERS, runAuthLogin } from './auth'
import { type AuthInterruptSource, processInterrupts } from './auth-interrupts'

const PROMPT: OrcaAccountApprovalPrompt = {
  kind: 'approve-in-browser',
  verificationUrl: 'https://login.example.test/device',
  userCode: 'WDJB-MJHT',
  machineLabel: 'devbox',
  expiresAt: 1_000_000
}

const SIGNED_IN: OrcaAccountServerStatus = {
  state: 'signed-in',
  email: 'person@example.test',
  orgId: 'org-1',
  orgName: 'Personal',
  organizations: [
    { orgId: 'org-1', name: 'Personal' },
    { orgId: 'org-2', name: 'Acme' }
  ],
  storage: { kind: 'host-key', warning: 'Sealed with a key kept on this host.' }
}

const SIGNED_OUT: OrcaAccountServerStatus = {
  state: 'signed-out',
  storage: { kind: 'host-key', warning: 'Sealed with a key kept on this host.' }
}

const CAPABILITIES = [
  'orca-account.server-sign-in.v1',
  'orca-account.server-sign-in.approve-in-browser.v1'
]

type Handler = (params: Record<string, unknown> | undefined) => unknown

function fakeHost(overrides: Record<string, Handler> = {}) {
  const handlers: Record<string, Handler> = {
    'status.get': () => ({ capabilities: CAPABILITIES }),
    'orcaAccount.status': () => SIGNED_OUT,
    'orcaAccount.signIn.start': () => ({
      flowId: 'flow-1',
      provider: 'sign-in',
      revision: 1,
      phase: 'starting'
    }),
    'orcaAccount.signIn.wait': (params) =>
      params?.afterRevision === 1
        ? { flowId: 'flow-1', provider: 'sign-in', revision: 2, phase: 'waiting', prompt: PROMPT }
        : {
            flowId: 'flow-1',
            provider: 'sign-in',
            revision: 4,
            phase: 'signedIn',
            account: SIGNED_IN
          },
    'orcaAccount.signIn.cancel': () => ({}),
    'orcaAccount.selectOrg': () => ({ ...SIGNED_IN, orgId: 'org-2', orgName: 'Acme' }),
    'orcaAccount.signOut': () => SIGNED_OUT,
    ...overrides
  }
  const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    const handler = handlers[method]
    if (!handler) {
      throw new Error(`unexpected ${method}`)
    }
    return { id: 'req', ok: true, result: await handler(params), _meta: { runtimeId: 'rt' } }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test only use `call`.
  const client = { call } as unknown as RuntimeClient
  return { call, client }
}

/** An interrupt source the test fires by hand, recording whether anyone still listens. */
function manualInterrupts() {
  let listener: ((signal: NodeJS.Signals) => void) | null = null
  const source: AuthInterruptSource = (onInterrupt) => {
    listener = onInterrupt
    return () => {
      listener = null
    }
  }
  return { source, fire: () => listener?.('SIGINT'), listening: () => listener !== null }
}

/** A host still waiting for the browser approval until `approve` is called. */
function approvalPending(overrides: Record<string, Handler> = {}) {
  let approve: () => void = () => {}
  const approved = new Promise<void>((resolve) => {
    approve = resolve
  })
  const host = fakeHost({
    'orcaAccount.signIn.wait': async (params) => {
      if (params?.afterRevision === 1) {
        return { flowId: 'flow-1', revision: 2, phase: 'waiting', prompt: PROMPT }
      }
      await approved
      return { flowId: 'flow-1', revision: 4, phase: 'signedIn', account: SIGNED_IN }
    },
    ...overrides
  })
  return { ...host, approve }
}

function context(client: RuntimeClient, flags: [string, string | boolean][] = []): HandlerContext {
  return { client, cwd: process.cwd(), flags: new Map(flags), json: false, rawArgs: [] }
}

describe('orca auth', () => {
  let stderr: string
  let stdout: string[]

  beforeEach(() => {
    stderr = ''
    stdout = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      stdout.push(String(line))
    })
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('shows the link and the code to compare, waits for the approval, and reports the account', async () => {
    const { call, client } = fakeHost()

    await runAuthLogin(context(client), manualInterrupts().source)

    expect(call).toHaveBeenCalledWith('orcaAccount.signIn.start', {
      switchAccount: false,
      approveInBrowser: true
    })
    expect(stderr).toContain('devbox')
    expect(stderr).toContain('https://login.example.test/device')
    expect(stderr).toContain('WDJB-MJHT')
    expect(stderr).toContain('Sealed with a key kept on this host.')
    expect(call).not.toHaveBeenCalledWith('orcaAccount.signIn.complete', expect.anything())
    expect(call).not.toHaveBeenCalledWith('orcaAccount.signIn.cancel', expect.anything())
    expect(stdout.join('\n')).toContain('person@example.test · Personal')
  })

  it('selects the organization named by --org after signing in', async () => {
    const { call, client } = fakeHost()

    await runAuthLogin(context(client, [['org', 'acme']]), manualInterrupts().source)

    expect(call).toHaveBeenCalledWith('orcaAccount.selectOrg', { orgId: 'org-2' })
    expect(stdout.join('\n')).toContain('Signed in as person@example.test · Acme')
  })

  it('asks the host to switch accounts only with --switch', async () => {
    const { call, client } = fakeHost()

    await runAuthLogin(context(client, [['switch', true]]), manualInterrupts().source)

    expect(call).toHaveBeenCalledWith('orcaAccount.signIn.start', {
      switchAccount: true,
      approveInBrowser: true
    })
  })

  it('reports why the host would not start a sign-in', async () => {
    const { client } = fakeHost({
      'orcaAccount.signIn.wait': () => ({
        flowId: 'flow-1',
        revision: 2,
        phase: 'failed',
        error: "Orca Cloud doesn't support server sign-in yet."
      })
    })

    await expect(runAuthLogin(context(client), manualInterrupts().source)).rejects.toThrow(
      "Orca Cloud doesn't support server sign-in yet."
    )
  })

  it('reports the host’s reason when browser approval fails', async () => {
    const error = 'The sign-in was declined in the browser.'
    const { client } = fakeHost({
      'orcaAccount.signIn.wait': (params) =>
        params?.afterRevision === 1
          ? { flowId: 'flow-1', revision: 2, phase: 'waiting', prompt: PROMPT }
          : { flowId: 'flow-1', revision: 3, phase: 'failed', error }
    })

    await expect(runAuthLogin(context(client), manualInterrupts().source)).rejects.toThrow(error)
    expect(stdout).toEqual([])
  })

  it('on Ctrl+C while waiting for approval, cancels on the host, waits for it, and stops listening', async () => {
    const { call, client } = approvalPending({
      'orcaAccount.signIn.cancel': () => ({ flowId: 'flow-1', revision: 5, phase: 'cancelled' })
    })
    const interrupts = manualInterrupts()
    const login = runAuthLogin(context(client), interrupts.source)
    await vi.waitFor(() => expect(stderr).toContain('Waiting for you to approve'))

    interrupts.fire()

    await expect(login).rejects.toThrow('Sign-in cancelled.')
    expect(call).toHaveBeenCalledWith(
      'orcaAccount.signIn.cancel',
      { flowId: 'flow-1' },
      { timeoutMs: 15_000 }
    )
    expect(
      call.mock.calls.filter(([method]) => method === 'orcaAccount.signIn.cancel')
    ).toHaveLength(1)
    expect(interrupts.listening()).toBe(false)
  })

  it('says so when the sign-in had already finished before the interrupt reached the host', async () => {
    const { client, approve } = approvalPending({
      'orcaAccount.signIn.cancel': () => ({ flowId: 'flow-1', revision: 4, phase: 'signedIn' })
    })
    const interrupts = manualInterrupts()
    const login = runAuthLogin(context(client), interrupts.source)
    await vi.waitFor(() => expect(stderr).toContain('Waiting for you to approve'))

    interrupts.fire()

    await expect(login).rejects.toThrow(
      'Interrupted, but the sign-in had already finished: this host is signed in. Run `orca auth logout` to undo it.'
    )
    approve()
    expect(stdout).toEqual([])
  })

  it("does not claim a cancel the host didn't confirm", async () => {
    const { client } = approvalPending({
      'orcaAccount.signIn.cancel': () => {
        throw new Error('timed out')
      }
    })
    const interrupts = manualInterrupts()
    const login = runAuthLogin(context(client), interrupts.source)
    await vi.waitFor(() => expect(interrupts.listening()).toBe(true))

    interrupts.fire()

    await expect(login).rejects.toThrow("the host didn't confirm the sign-in stopped")
  })

  it('takes SIGINT, SIGTERM and SIGHUP while listening, and gives them back afterwards', () => {
    const heard: string[] = []
    const before = process.listenerCount('SIGINT')
    const stop = processInterrupts((signal) => heard.push(signal))

    // Node passes the signal's name to its listeners.
    process.emit('SIGINT', 'SIGINT')
    process.emit('SIGTERM', 'SIGTERM')
    process.emit('SIGHUP', 'SIGHUP')
    stop()

    expect(heard).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP'])
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  it('refuses a host that only supports paste-back sign-in', async () => {
    const capabilities = ['orca-account.server-sign-in.v1']
    const { call, client } = fakeHost({ 'status.get': () => ({ capabilities }) })

    await expect(runAuthLogin(context(client), manualInterrupts().source)).rejects.toThrow(
      'too old to sign in from the terminal. Update Orca on this host'
    )
    expect(call).not.toHaveBeenCalledWith('orcaAccount.signIn.start', expect.anything())
  })

  it('refuses to retarget another host', async () => {
    const { client } = fakeHost()

    await expect(
      runAuthLogin(context(client, [['environment', 'other']]), manualInterrupts().source)
    ).rejects.toThrow('Run it in a terminal on the host you want to sign in.')
  })

  it('exits 0 from status only when signed in, on hosts with or without approve-in-browser', async () => {
    const signedOut = fakeHost({
      'status.get': () => ({ capabilities: ['orca-account.server-sign-in.v1'] })
    })
    await AUTH_HANDLERS['auth status']?.(context(signedOut.client))
    expect(process.exitCode).toBe(1)
    expect(stdout.join('\n')).toContain('Not signed in.')

    process.exitCode = undefined
    const signedIn = fakeHost({ 'orcaAccount.status': () => SIGNED_IN })
    await AUTH_HANDLERS['auth status']?.(context(signedIn.client))
    expect(process.exitCode).toBeUndefined()
  })

  it('signs the host out', async () => {
    const { call, client } = fakeHost()

    await AUTH_HANDLERS['auth logout']?.(context(client))

    expect(call).toHaveBeenCalledWith('orcaAccount.signOut')
    expect(stdout.join('\n')).toContain('Not signed in.')
  })
})
