import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type {
  CodexRateLimitAccountsState,
  ClaudeRateLimitAccountsState
} from '../../shared/managed-account-types'

function createRuntimeWithAccountServices(overrides: {
  codexAddAccount?: (
    target: unknown,
    onOutput?: (chunk: string) => void,
    options?: { deviceAuth?: boolean }
  ) => Promise<CodexRateLimitAccountsState>
  claudeAddAccount?: (
    target: unknown,
    onOutput?: (chunk: string) => void,
    options?: {
      remoteAuth?: boolean
      onChildReady?: (writeInput: (text: string) => void) => void
    }
  ) => Promise<ClaudeRateLimitAccountsState>
}): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(null)
  runtime.setAccountServices({
    codexAccounts: { addAccount: overrides.codexAddAccount ?? vi.fn() } as never,
    claudeAccounts: { addAccount: overrides.claudeAddAccount ?? vi.fn() } as never,
    rateLimits: {} as never
  })
  return runtime
}

describe('OrcaRuntimeService headless account add', () => {
  it('forwards live output chunks into the poll snapshot before the login settles', async () => {
    let capturedOnOutput: ((chunk: string) => void) | undefined
    const addAccountPromise = new Promise<CodexRateLimitAccountsState>(() => {
      // Why: intentionally never resolves — this test only inspects state
      // while the login is still in progress.
    })
    const runtime = createRuntimeWithAccountServices({
      codexAddAccount: vi.fn((_target, onOutput) => {
        capturedOnOutput = onOutput
        return addAccountPromise
      })
    })

    const { loginId } = runtime.addCodexAccount()
    capturedOnOutput?.('open this URL to sign in\n')

    const snapshot = await runtime.pollAddAccount(loginId, { timeoutMs: 10 })

    expect(snapshot.status).toBe('in_progress')
    expect(snapshot.outputTail).toBe('open this URL to sign in\n')
  })

  it('requests Codex device-code auth, since this RPC has no local browser sharing the login machine', async () => {
    const codexAddAccount = vi.fn(
      () =>
        new Promise<CodexRateLimitAccountsState>(() => {
          // Why: this test only inspects the call arguments, not resolution.
        })
    )
    const runtime = createRuntimeWithAccountServices({ codexAddAccount })

    runtime.addCodexAccount()

    expect(codexAddAccount).toHaveBeenCalledWith(undefined, expect.any(Function), {
      deviceAuth: true
    })
  })

  it('resolves pollAddAccount as completed once a Codex login succeeds', async () => {
    let resolveAddAccount: ((state: CodexRateLimitAccountsState) => void) | undefined
    const addAccountPromise = new Promise<CodexRateLimitAccountsState>((resolve) => {
      resolveAddAccount = resolve
    })
    const finalState: CodexRateLimitAccountsState = {
      accounts: [],
      activeAccountId: 'account-1'
    }
    const runtime = createRuntimeWithAccountServices({
      codexAddAccount: vi.fn(() => addAccountPromise)
    })

    const { loginId } = runtime.addCodexAccount()
    const pollPromise = runtime.pollAddAccount(loginId, { timeoutMs: 30_000 })
    resolveAddAccount?.(finalState)

    await expect(pollPromise).resolves.toEqual({
      loginId,
      provider: 'codex',
      status: 'completed',
      outputTail: '',
      state: finalState
    })
  })

  it('propagates a failed Claude login as a pollAddAccount error', async () => {
    let rejectAddAccount: ((error: Error) => void) | undefined
    const addAccountPromise = new Promise<ClaudeRateLimitAccountsState>((_resolve, reject) => {
      rejectAddAccount = reject
    })
    const runtime = createRuntimeWithAccountServices({
      claudeAddAccount: vi.fn(() => addAccountPromise)
    })

    const { loginId } = runtime.addClaudeAccount()
    const pollPromise = runtime.pollAddAccount(loginId, { timeoutMs: 30_000 })
    rejectAddAccount?.(new Error('Claude sign-in was denied. Please try again.'))

    await expect(pollPromise).resolves.toEqual({
      loginId,
      provider: 'claude',
      status: 'failed',
      outputTail: '',
      error: 'Claude sign-in was denied. Please try again.'
    })
  })

  it('rejects polling an unknown loginId', async () => {
    const runtime = createRuntimeWithAccountServices({})

    await expect(runtime.pollAddAccount('missing-login')).rejects.toThrow(
      'That account login no longer exists.'
    )
  })

  it('requests remote Claude auth and wires an input writer into the pending login', async () => {
    const claudeAddAccount = vi.fn(
      (
        _target: unknown,
        _onOutput?: (chunk: string) => void,
        _options?: {
          remoteAuth?: boolean
          onChildReady?: (writeInput: (text: string) => void) => void
        }
      ) =>
        new Promise<ClaudeRateLimitAccountsState>(() => {
          // Why: this test only inspects the call arguments, not resolution.
        })
    )
    const runtime = createRuntimeWithAccountServices({ claudeAddAccount })

    const { loginId } = runtime.addClaudeAccount()

    expect(claudeAddAccount).toHaveBeenCalledWith(undefined, expect.any(Function), {
      remoteAuth: true,
      onChildReady: expect.any(Function)
    })

    // Why: exercise the onChildReady wiring end-to-end — the writer registered
    // here should be reachable through submitAccountLoginInput once the child
    // process signals it is ready to receive the pasted code.
    const onChildReady = claudeAddAccount.mock.calls[0][2]?.onChildReady
    const writeInput = vi.fn()
    onChildReady?.(writeInput)

    runtime.submitAccountLoginInput(loginId, 'pasted-code')
    expect(writeInput).toHaveBeenCalledWith('pasted-code')
  })

  it('rejects submitting input for an unknown loginId', () => {
    const runtime = createRuntimeWithAccountServices({})

    expect(() => runtime.submitAccountLoginInput('missing-login', 'pasted-code')).toThrow(
      'That account login no longer exists.'
    )
  })
})
