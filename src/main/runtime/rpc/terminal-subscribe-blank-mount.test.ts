/** STA-1840 regression: missing mobile terminal models request an exact renderer tab mount. */
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    registerRemoteTerminalViewSubscriber: () => () => {},
    requestRendererTerminalTabMount: () => false,
    getRendererTerminalSerializerGenerationForHandle: () => 0,
    getRendererTerminalSerializerGeneration: () => 0,
    waitForRendererTerminalSerializer: async () => false,
    getPtyOutputSequence: () => 0,
    replaceHeadlessTerminalFromRendererSnapshotForRecovery: () => {},
    serializeRendererTerminalBuffer: async () => null,
    hasHeadlessTerminalState: () => true,
    ...overrides
  } as OrcaRuntimeService
}

const makeRequest = (method: string, params?: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method,
  params
})

describe('terminal.subscribe blank-tab background mount', () => {
  it('does not mount a hidden tab for an already-aborted mobile subscribe', async () => {
    const controller = new AbortController()
    controller.abort()
    const requestRendererTerminalTabMount = vi.fn(() => true)
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue(null),
      requestRendererTerminalTabMount,
      waitForLeafPtyId: vi.fn(),
      readTerminal: vi.fn()
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'phone-1', type: 'mobile' },
        capabilities: { terminalBinaryStream: 1 }
      }),
      vi.fn(),
      {
        signal: controller.signal,
        connectionId: 'conn-phone',
        sendBinary: vi.fn(),
        registerBinaryStreamHandler: vi.fn(() => vi.fn())
      }
    )

    expect(requestRendererTerminalTabMount).not.toHaveBeenCalled()
    expect(runtime.waitForLeafPtyId).not.toHaveBeenCalled()
    expect(runtime.readTerminal).not.toHaveBeenCalled()
  })

  it('requests a renderer tab mount when a mobile subscribe has no headless model', async () => {
    // Why: stale preview text must not hide the missing live model/attachment.
    const cleanups = new Map<string, () => void>()
    const callOrder: string[] = []
    const unsubscribeData = vi.fn()
    const requestRendererTerminalTabMount = vi.fn(() => {
      callOrder.push('request-mount')
      return true
    })
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      requestRendererTerminalTabMount,
      hasHeadlessTerminalState: vi.fn().mockReturnValue(false),
      handleMobileSubscribe: vi.fn().mockResolvedValue(true),
      handleMobileUnsubscribe: vi.fn(),
      subscribeToTerminalData: vi.fn(() => {
        callOrder.push('subscribe-data')
        return unsubscribeData
      }),
      readTerminal: vi.fn().mockResolvedValue({ tail: ['stale preview'], truncated: false }),
      serializeTerminalBuffer: vi
        .fn()
        .mockResolvedValue({ data: 'stale snapshot', cols: 80, rows: 24, seq: 4 }),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        cleanups.get(id)?.()
        cleanups.delete(id)
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'phone-1', type: 'mobile' },
        capabilities: { terminalBinaryStream: 1 }
      }),
      vi.fn(),
      {
        connectionId: 'conn-phone',
        sendBinary: vi.fn(),
        registerBinaryStreamHandler: vi.fn(() => vi.fn())
      }
    )

    await vi.waitFor(() =>
      expect(requestRendererTerminalTabMount).toHaveBeenCalledWith('terminal-1')
    )
    expect(callOrder).toEqual(['subscribe-data', 'request-mount'])

    runtime.cleanupSubscription('terminal-1:phone-1')
    await dispatchPromise
    expect(unsubscribeData).toHaveBeenCalledTimes(1)
  })

  it('does not request a renderer tab mount when an attached terminal is legitimately blank', async () => {
    const cleanups = new Map<string, () => void>()
    const requestRendererTerminalTabMount = vi.fn(() => true)
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      requestRendererTerminalTabMount,
      handleMobileSubscribe: vi.fn().mockResolvedValue(true),
      handleMobileUnsubscribe: vi.fn(),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        cleanups.get(id)?.()
        cleanups.delete(id)
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'phone-1', type: 'mobile' },
        capabilities: { terminalBinaryStream: 1 }
      }),
      vi.fn(),
      {
        connectionId: 'conn-phone',
        sendBinary: vi.fn(),
        registerBinaryStreamHandler: vi.fn(() => vi.fn())
      }
    )

    await vi.waitFor(() => expect(runtime.handleMobileSubscribe).toHaveBeenCalled())
    expect(requestRendererTerminalTabMount).not.toHaveBeenCalled()

    runtime.cleanupSubscription('terminal-1:phone-1')
    await dispatchPromise
  })

  it('does not wait for a remount when the current snapshot came from the renderer', async () => {
    const cleanups = new Map<string, () => void>()
    const requestRendererTerminalTabMount = vi.fn(() => true)
    const waitForRendererTerminalSerializer = vi.fn()
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      requestRendererTerminalTabMount,
      waitForRendererTerminalSerializer,
      hasHeadlessTerminalState: vi.fn().mockReturnValue(false),
      handleMobileSubscribe: vi.fn().mockResolvedValue(true),
      handleMobileUnsubscribe: vi.fn(),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue({
        data: 'current renderer prompt $ ',
        cols: 80,
        rows: 24,
        source: 'renderer'
      }),
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
      subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        cleanups.get(id)?.()
        cleanups.delete(id)
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'phone-1', type: 'mobile' },
        capabilities: { terminalBinaryStream: 1 }
      }),
      vi.fn(),
      {
        connectionId: 'conn-phone',
        sendBinary: vi.fn(),
        registerBinaryStreamHandler: vi.fn(() => vi.fn())
      }
    )

    await vi.waitFor(() => expect(runtime.handleMobileSubscribe).toHaveBeenCalled())
    expect(requestRendererTerminalTabMount).not.toHaveBeenCalled()
    expect(waitForRendererTerminalSerializer).not.toHaveBeenCalled()

    runtime.cleanupSubscription('terminal-1:phone-1')
    await dispatchPromise
  })
})
