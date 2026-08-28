import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'
import { AGENT_SESSION_EXECUTION_OWNER_PROTOCOL_VERSION } from '../../shared/agent-session-host-authority'
import {
  createMockMux,
  expectRequest,
  type MockMultiplexer
} from './ssh-pty-provider-mock-multiplexer'

describe('SshPtyProvider', () => {
  let mux: MockMultiplexer
  let provider: SshPtyProvider
  const scopedPty1 = 'ssh:conn-1@@pty-1'

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshPtyProvider('conn-1', mux as never)
  })

  it('returns the connectionId', () => {
    expect(provider.getConnectionId()).toBe('conn-1')
  })

  it('reports that SSH panes cannot restore from authoritative provider snapshots', () => {
    expect(provider.canProvideAuthoritativeBufferSnapshot(scopedPty1)).toBe(false)
  })

  it('fails closed without foreground-shell proof on direct SSH', () => {
    expect(
      (provider as { confirmShellForeground?: unknown }).confirmShellForeground
    ).toBeUndefined()
    expect(mux.request).not.toHaveBeenCalled()
  })

  it('keeps a shared claim probe alive when one waiter disconnects', async () => {
    let finishProbe!: (result: { agentSessionClaimVersion: number }) => void
    mux.request.mockReturnValueOnce(
      new Promise((resolve) => {
        finishProbe = resolve
      })
    )
    const abort = new AbortController()
    const canceled = provider.supportsAgentSessionClaims({ signal: abort.signal })
    const live = provider.supportsAgentSessionClaims()

    abort.abort()
    await expect(canceled).resolves.toBe(false)
    finishProbe({ agentSessionClaimVersion: AGENT_SESSION_EXECUTION_OWNER_PROTOCOL_VERSION })
    await expect(live).resolves.toBe(true)
    expect(mux.request).toHaveBeenCalledOnce()
  })

  it('attach sends pty.attach request', async () => {
    await provider.attach(scopedPty1)
    expectRequest(mux.request, 'pty.attach', { id: 'pty-1' })
  })

  it('attachForReconnect returns replay without relay notification', async () => {
    mux.request.mockResolvedValue({
      replay: 'restored output',
      incarnationId: 'incarnation-reconnect'
    })

    const result = await provider.attachForReconnect(scopedPty1)

    expect(result).toEqual({
      replay: 'restored output',
      incarnationId: 'incarnation-reconnect'
    })
    expectRequest(
      mux.request,
      'pty.attach',
      {
        id: 'pty-1',
        suppressReplayNotification: true
      },
      expect.objectContaining({
        timeoutMs: 10_000,
        beforeResolve: expect.any(Function)
      })
    )
  })

  it('keeps missing incarnation compatible with an old relay', async () => {
    mux.request.mockResolvedValue({ replay: 'legacy replay' })

    await expect(provider.attachForReconnect(scopedPty1)).resolves.toEqual({
      replay: 'legacy replay'
    })
  })

  it('rejects a present malformed attach incarnation', async () => {
    mux.request.mockResolvedValue({ incarnationId: '' })

    await expect(provider.attachForReconnect(scopedPty1)).rejects.toThrow(
      'Invalid SSH PTY attach incarnation'
    )
  })

  it('attachForReconnect forwards expected identity when provided', async () => {
    await provider.attachForReconnect(scopedPty1, {
      paneKey: 'tab-a:leaf-a',
      tabId: 'tab-a'
    })

    expectRequest(
      mux.request,
      'pty.attach',
      {
        id: 'pty-1',
        suppressReplayNotification: true,
        expectedPaneKey: 'tab-a:leaf-a',
        expectedTabId: 'tab-a'
      },
      expect.objectContaining({
        timeoutMs: 10_000,
        beforeResolve: expect.any(Function)
      })
    )
  })

  it('write sends pty.data notification', () => {
    provider.write(scopedPty1, 'hello')
    expect(mux.notify).toHaveBeenCalledWith('pty.data', { id: 'pty-1', data: 'hello' })
  })

  it('resize sends pty.resize notification', () => {
    provider.resize(scopedPty1, 120, 40)
    expect(mux.notify).toHaveBeenCalledWith('pty.resize', { id: 'pty-1', cols: 120, rows: 40 })
  })

  it('reads the applied PTY size from the relay', async () => {
    mux.request.mockResolvedValue({ cols: 120, rows: 40 })

    await expect(provider.getAppliedSize(scopedPty1)).resolves.toEqual({ cols: 120, rows: 40 })
    expectRequest(mux.request, 'pty.getSize', { id: 'pty-1' }, { timeoutMs: 1_000 })
  })

  it('caches only an old relay method-not-found response', async () => {
    mux.request.mockRejectedValue(Object.assign(new Error('Method not found'), { code: -32601 }))

    await expect(provider.getAppliedSize(scopedPty1)).resolves.toBeNull()
    await expect(provider.getAppliedSize(scopedPty1)).resolves.toBeNull()
    expect(mux.request).toHaveBeenCalledTimes(1)
  })

  it('retries an applied-size read after a transient relay failure', async () => {
    mux.request
      .mockRejectedValueOnce(
        Object.assign(new Error('connection lost'), { code: 'CONNECTION_LOST' })
      )
      .mockResolvedValueOnce({ cols: 100, rows: 30 })

    await expect(provider.getAppliedSize(scopedPty1)).resolves.toBeNull()
    await expect(provider.getAppliedSize(scopedPty1)).resolves.toEqual({ cols: 100, rows: 30 })
    expect(mux.request).toHaveBeenCalledTimes(2)
  })

  it('shutdown sends pty.shutdown request', async () => {
    await provider.shutdown(scopedPty1, { immediate: true })
    expectRequest(
      mux.request,
      'pty.shutdown',
      {
        id: 'pty-1',
        immediate: true,
        keepHistory: false
      },
      undefined
    )
  })

  it('shutdown forwards keepHistory: true over the relay', async () => {
    await provider.shutdown(scopedPty1, { immediate: true, keepHistory: true })
    expectRequest(
      mux.request,
      'pty.shutdown',
      {
        id: 'pty-1',
        immediate: true,
        keepHistory: true
      },
      undefined
    )
  })

  it('shutdown bounds the relay RPC by the teardown deadline', async () => {
    // Why: freeze Date.now() so the leaf conversion deadline -> remaining relative
    // timeout is exact and the mux receives precisely the leftover budget.
    vi.useFakeTimers()
    try {
      await provider.shutdown(scopedPty1, { immediate: true, deadlineMs: Date.now() + 4321 })
      expectRequest(
        mux.request,
        'pty.shutdown',
        { id: 'pty-1', immediate: true, keepHistory: false },
        { timeoutMs: 4321 }
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('sendSignal sends pty.sendSignal request', async () => {
    await provider.sendSignal(scopedPty1, 'SIGINT')
    expectRequest(mux.request, 'pty.sendSignal', { id: 'pty-1', signal: 'SIGINT' })
  })

  it('getCwd sends pty.getCwd request', async () => {
    mux.request.mockResolvedValue('/home/user/project')
    const cwd = await provider.getCwd(scopedPty1)
    expect(cwd).toBe('/home/user/project')
    expectRequest(mux.request, 'pty.getCwd', { id: 'pty-1' })
  })

  it('clearBuffer sends pty.clearBuffer request', async () => {
    await provider.clearBuffer(scopedPty1)
    expectRequest(mux.request, 'pty.clearBuffer', { id: 'pty-1' })
  })

  it('acknowledgeDataEvent sends pty.ackData notification', () => {
    provider.acknowledgeDataEvent(scopedPty1, 1024)
    expect(mux.notify).toHaveBeenCalledWith('pty.ackData', { id: 'pty-1', charCount: 1024 })
  })

  it('hasChildProcesses sends request and returns result', async () => {
    mux.request.mockResolvedValue(true)
    const result = await provider.hasChildProcesses(scopedPty1)
    expect(result).toBe(true)
    expectRequest(mux.request, 'pty.hasChildProcesses', { id: 'pty-1' })
  })

  it('getForegroundProcess returns process name', async () => {
    mux.request.mockResolvedValue('node')
    const result = await provider.getForegroundProcess(scopedPty1)
    expect(result).toBe('node')
    expectRequest(mux.request, 'pty.getForegroundProcess', { id: 'pty-1' })
  })

  it('preserves unavailable process inspection', async () => {
    const inspection = {
      foregroundProcess: null,
      hasChildProcesses: true,
      unavailable: true as const
    }
    mux.request.mockResolvedValue(inspection)

    await expect(provider.inspectProcess(scopedPty1)).resolves.toEqual(inspection)
    expectRequest(mux.request, 'pty.inspectProcess', { id: 'pty-1' })
  })

  it('serializes scoped app ids using raw relay ids', async () => {
    mux.request.mockResolvedValue('serialized')

    const result = await provider.serialize([scopedPty1])

    expect(result).toBe('serialized')
    expectRequest(mux.request, 'pty.serialize', { ids: ['pty-1'] })
  })

  it('rejects scoped ids owned by another SSH connection', async () => {
    await expect(provider.shutdown('ssh:conn-2@@pty-1', { immediate: true })).rejects.toThrow(
      'belongs to SSH connection "conn-2"'
    )
  })

  it('getDefaultShell returns shell path', async () => {
    mux.request.mockResolvedValue('/bin/bash')
    const result = await provider.getDefaultShell()
    expect(result).toBe('/bin/bash')
  })

  describe('event listeners', () => {
    it('forwards pty.data notifications to data listeners', () => {
      const handler = vi.fn()
      provider.onData(handler)

      // Get the notification handler that was registered
      const notifHandler = mux.onNotification.mock.calls[0][0]
      notifHandler('pty.data', { id: 'pty-1', data: 'output' })

      expect(handler).toHaveBeenCalledWith({ id: scopedPty1, data: 'output' })
    })

    it('preserves the provider-issued terminal handle on lifecycle notifications', () => {
      const dataHandler = vi.fn()
      const exitHandler = vi.fn()
      provider.onData(dataHandler)
      provider.onExit(exitHandler)

      const notifHandler = mux.onNotification.mock.calls[0][0]
      notifHandler('pty.data', {
        id: 'pty-grid',
        data: 'early output',
        terminalHandle: 'term_grid_target'
      })
      notifHandler('pty.exit', {
        id: 'pty-grid',
        code: 17,
        terminalHandle: 'term_grid_target'
      })

      expect(dataHandler).toHaveBeenCalledWith({
        id: 'ssh:conn-1@@pty-grid',
        data: 'early output',
        terminalHandle: 'term_grid_target'
      })
      expect(exitHandler).toHaveBeenCalledWith({
        id: 'ssh:conn-1@@pty-grid',
        code: 17,
        terminalHandle: 'term_grid_target'
      })
    })

    it('forwards pty.replay notifications to replay listeners', () => {
      const handler = vi.fn()
      provider.onReplay(handler)

      const notifHandler = mux.onNotification.mock.calls[0][0]
      notifHandler('pty.replay', { id: 'pty-1', data: 'buffered output' })

      expect(handler).toHaveBeenCalledWith({ id: scopedPty1, data: 'buffered output' })
    })

    it('forwards pty.exit notifications to exit listeners', () => {
      const handler = vi.fn()
      provider.onExit(handler)

      const notifHandler = mux.onNotification.mock.calls[0][0]
      notifHandler('pty.exit', { id: 'pty-1', code: 0 })

      expect(handler).toHaveBeenCalledWith({ id: scopedPty1, code: 0 })
    })

    it('allows unsubscribing from events', () => {
      const handler = vi.fn()
      const unsub = provider.onData(handler)
      unsub()

      const notifHandler = mux.onNotification.mock.calls[0][0]
      notifHandler('pty.data', { id: 'pty-1', data: 'output' })

      expect(handler).not.toHaveBeenCalled()
    })

    it('supports multiple listeners', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      provider.onData(handler1)
      provider.onData(handler2)

      const notifHandler = mux.onNotification.mock.calls[0][0]
      notifHandler('pty.data', { id: 'pty-1', data: 'output' })

      expect(handler1).toHaveBeenCalled()
      expect(handler2).toHaveBeenCalled()
    })

    it('namespaces identical relay ids from different SSH connections', () => {
      const otherMux = createMockMux()
      const otherProvider = new SshPtyProvider('conn-2', otherMux as never)
      const firstHandler = vi.fn()
      const secondHandler = vi.fn()
      provider.onData(firstHandler)
      otherProvider.onData(secondHandler)

      mux.onNotification.mock.calls[0][0]('pty.data', { id: 'pty-1', data: 'first' })
      otherMux.onNotification.mock.calls[0][0]('pty.data', { id: 'pty-1', data: 'second' })

      expect(firstHandler).toHaveBeenCalledWith({ id: scopedPty1, data: 'first' })
      expect(secondHandler).toHaveBeenCalledWith({ id: 'ssh:conn-2@@pty-1', data: 'second' })
    })
  })
})
