import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION } from '../../shared/agent-session-host-authority'
import { SshPtyProvider } from './ssh-pty-provider'

describe('SSH fresh agent-session create operations', () => {
  const request = vi.fn()
  let provider: SshPtyProvider

  beforeEach(() => {
    request.mockReset()
    provider = new SshPtyProvider('conn-1', {
      request,
      notify: vi.fn(),
      onNotification: vi.fn(),
      dispose: vi.fn(),
      isDisposed: vi.fn(() => false)
    } as never)
  })

  it('sends operation identity only to a capable relay', async () => {
    request.mockImplementation(async (method: string) =>
      method === 'pty.getCapabilities'
        ? { agentSessionCreateOperationVersion: AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION }
        : { id: 'pty-operation', incarnationId: 'incarnation-operation' }
    )

    await provider.spawn({
      cols: 80,
      rows: 24,
      command: 'codex',
      agentSessionCreateOperationId: 'a'.repeat(43)
    })

    expect(request).toHaveBeenNthCalledWith(1, 'pty.getCapabilities', undefined, {
      signal: undefined,
      timeoutMs: 5_000
    })
    expect(request).toHaveBeenNthCalledWith(2, 'pty.spawn', {
      cols: 80,
      rows: 24,
      cwd: undefined,
      env: { POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD: 'true' },
      command: 'codex',
      agentSessionCreateOperationId: 'a'.repeat(43)
    })
  })

  it('does not downgrade after structured dispatch reaches an old relay', async () => {
    request.mockResolvedValueOnce({})

    await expect(
      provider.spawn({
        cols: 80,
        rows: 24,
        command: 'codex',
        agentSessionCreateOperationId: 'b'.repeat(43)
      })
    ).rejects.toThrow('execution_owner_unavailable')
    expect(request).toHaveBeenCalledOnce()
  })

  it('keeps a client-selected old-relay spawn byte-for-byte legacy', async () => {
    request.mockResolvedValueOnce({ id: 'pty-legacy' })

    await expect(
      provider.spawn({
        cols: 80,
        rows: 24,
        command: 'codex'
      })
    ).resolves.toMatchObject({ id: 'ssh:conn-1@@pty-legacy' })

    expect(request).toHaveBeenNthCalledWith(1, 'pty.spawn', {
      cols: 80,
      rows: 24,
      cwd: undefined,
      env: { POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD: 'true' },
      command: 'codex'
    })
  })

  it('re-probes a negative capability after an in-place relay upgrade', async () => {
    request.mockResolvedValueOnce({}).mockResolvedValueOnce({
      agentSessionCreateOperationVersion: AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION
    })

    await expect(provider.supportsAgentSessionCreateOperations()).resolves.toBe(false)
    await expect(provider.supportsAgentSessionCreateOperations()).resolves.toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('keeps a shared capability probe alive when one waiter disconnects', async () => {
    let finishProbe!: (result: { agentSessionCreateOperationVersion: number }) => void
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        finishProbe = resolve
      })
    )
    const abort = new AbortController()
    const canceled = provider.supportsAgentSessionCreateOperations({ signal: abort.signal })
    const live = provider.supportsAgentSessionCreateOperations()

    abort.abort()
    await expect(canceled).resolves.toBe(false)
    finishProbe({
      agentSessionCreateOperationVersion: AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION
    })
    await expect(live).resolves.toBe(true)
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not dispatch create after cancellation during its capability gate', async () => {
    let finishProbe!: (result: { agentSessionCreateOperationVersion: number }) => void
    request.mockReturnValueOnce(
      new Promise((resolve) => {
        finishProbe = resolve
      })
    )
    const abort = new AbortController()
    const spawn = provider.spawn({
      cols: 80,
      rows: 24,
      command: 'codex',
      agentSessionCreateOperationId: 'd'.repeat(43),
      signal: abort.signal
    })

    abort.abort()
    finishProbe({
      agentSessionCreateOperationVersion: AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION
    })
    await expect(spawn).rejects.toThrow('client_disconnected')
    expect(request.mock.calls.map((call) => call[0])).toEqual(['pty.getCapabilities'])
  })

  it('fences a malformed successful structured-create response', async () => {
    request
      .mockResolvedValueOnce({
        agentSessionCreateOperationVersion: AGENT_SESSION_CREATE_OPERATION_PROTOCOL_VERSION
      })
      .mockResolvedValueOnce({ id: 'pty-without-incarnation' })

    const failure = await provider
      .spawn({
        cols: 80,
        rows: 24,
        command: 'codex',
        agentSessionCreateOperationId: 'c'.repeat(43)
      })
      .catch((error: unknown) => error)

    expect(failure).toMatchObject({
      message: 'execution_owner_unavailable',
      agentSessionOperationOutcome: 'unknown'
    })
    expect(request).toHaveBeenCalledTimes(2)
  })
})
