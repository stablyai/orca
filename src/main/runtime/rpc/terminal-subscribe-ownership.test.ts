import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

const SUBSCRIPTION_ID = 'terminal-1:phone-1'

type Waiter = { resolve: () => void }

function stubRuntime(
  registry: ReturnType<typeof createSubscriptionRegistryDouble>,
  waiters: Waiter[],
  overrides: Record<string, unknown> = {}
): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    registerRemoteTerminalViewSubscriber: () => () => {},
    requestRendererTerminalTabMount: () => false,
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn(),
    subscribeToTerminalData: vi.fn(() => vi.fn()),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi
      .fn()
      .mockResolvedValue({ data: 'snapshot', cols: 80, rows: 24, seq: 4 }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    cleanupSubscriptionIfOwnedByConnection: vi.fn(registry.cleanupSubscriptionIfOwnedByConnection),
    subscribeToPtyExit: vi.fn((_ptyId: string, listener: () => void) => {
      waiters.push({ resolve: listener })
      return vi.fn()
    }),
    ...overrides
  } as unknown as OrcaRuntimeService
}

const makeRequest = (params: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method: 'terminal.subscribe',
  params
})

const binaryParams = {
  terminal: 'terminal-1',
  client: { id: 'phone-1', type: 'mobile' },
  capabilities: { terminalBinaryStream: 1 }
}

const leaseOnlyParams = {
  terminal: 'terminal-1',
  client: { id: 'phone-1', type: 'mobile' },
  capabilities: { terminalBinaryStream: 1, mobileInputLeaseOnly: 1 }
}

// No viewport: keeps the branch off the remote-desktop registration path so the test
// isolates the post-rebind snapshot continuation.
const legacyParams = {
  terminal: 'terminal-1',
  client: { id: 'phone-1', type: 'desktop' }
}

const streamOptions = (connectionId: string, signal?: AbortSignal) => ({
  signal,
  connectionId,
  sendBinary: vi.fn(),
  registerBinaryStreamHandler: vi.fn(() => vi.fn())
})

const flush = (ms = 20): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, ms))

describe('terminal.subscribe teardown ownership', () => {
  // T4(b): the anti-leak guard — an abort that is still the current owner must tear down.
  it('tears down the current owner when its own connection aborts', async () => {
    const registry = createSubscriptionRegistryDouble()
    const waiters: Waiter[] = []
    const runtime = stubRuntime(registry, waiters)
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const conn = new AbortController()

    void dispatcher.dispatchStreaming(makeRequest(binaryParams), vi.fn(), {
      ...streamOptions('conn-a', conn.signal)
    })
    await vi.waitFor(() => expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBeDefined())

    conn.abort()
    await flush()

    expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBeUndefined()
    expect(runtime.handleMobileUnsubscribe).toHaveBeenCalledWith('pty-1', 'phone-1')
  })

  // T4(c): a genuine terminal exit still tears down.
  it('tears down the current owner when the PTY exits', async () => {
    const registry = createSubscriptionRegistryDouble()
    const waiters: Waiter[] = []
    const runtime = stubRuntime(registry, waiters)
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    void dispatcher.dispatchStreaming(makeRequest(binaryParams), vi.fn(), streamOptions('conn-a'))
    await vi.waitFor(() => expect(waiters).toHaveLength(1))

    waiters[0]!.resolve()
    await flush()

    expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBeUndefined()
  })

  it('disposes an already-exited PTY observer before binding socket abort', async () => {
    const registry = createSubscriptionRegistryDouble()
    const unsubscribeExit = vi.fn()
    const runtime = stubRuntime(registry, [], {
      subscribeToPtyExit: vi.fn((_ptyId: string, listener: () => void) => {
        listener()
        return unsubscribeExit
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const conn = new AbortController()
    const addAbort = vi.spyOn(conn.signal, 'addEventListener')
    const options = streamOptions('conn-a', conn.signal)

    await dispatcher.dispatchStreaming(makeRequest(binaryParams), vi.fn(), options)

    expect(unsubscribeExit).toHaveBeenCalledOnce()
    expect(addAbort).not.toHaveBeenCalled()
  })

  // Why: the synchronous release runs cleanup before setup, so anything registered after it never gets torn down.
  it('registers nothing after an already-exited PTY releases the subscription', async () => {
    const registry = createSubscriptionRegistryDouble()
    const runtime = stubRuntime(registry, [], {
      subscribeToPtyExit: vi.fn((_ptyId: string, listener: () => void) => {
        listener()
        return vi.fn()
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const options = streamOptions('conn-a')

    await dispatcher.dispatchStreaming(makeRequest(binaryParams), vi.fn(), options)
    await flush()

    expect(options.registerBinaryStreamHandler).not.toHaveBeenCalled()
    expect(runtime.subscribeToTerminalData).not.toHaveBeenCalled()
    expect(runtime.subscribeToTerminalResize).not.toHaveBeenCalled()
    expect(runtime.handleMobileSubscribe).not.toHaveBeenCalled()
  })

  it('registers no remote-desktop viewer when an already-exited PTY releases the legacy JSON stream', async () => {
    const registry = createSubscriptionRegistryDouble()
    const updateRemoteDesktopViewer = vi.fn().mockResolvedValue(true)
    const runtime = stubRuntime(registry, [], {
      updateRemoteDesktopViewer,
      subscribeToPtyExit: vi.fn((_ptyId: string, listener: () => void) => {
        listener()
        return vi.fn()
      })
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    await dispatcher.dispatchStreaming(
      makeRequest({
        terminal: 'terminal-1',
        client: { id: 'desk-1', type: 'desktop' },
        viewport: { cols: 80, rows: 24 }
      }),
      vi.fn(),
      { connectionId: 'conn-a' }
    )
    await flush()

    expect(updateRemoteDesktopViewer).not.toHaveBeenCalled()
    expect(runtime.subscribeToTerminalData).not.toHaveBeenCalled()
  })

  // T8: the exit-waiter is only half the story — stale async continuations must be owned too.
  it('does not let a lease-only subscribe rejecting after a rebind retire the replacement', async () => {
    const registry = createSubscriptionRegistryDouble()
    const waiters: Waiter[] = []
    let failFirstSubscribe = (): void => {}
    const handleMobileSubscribe = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((_resolve, reject) => {
            failFirstSubscribe = () => reject(new Error('subscribe_failed'))
          })
      )
      .mockResolvedValue(true)
    const runtime = stubRuntime(registry, waiters, { handleMobileSubscribe })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    void dispatcher
      .dispatchStreaming(makeRequest(leaseOnlyParams), vi.fn(), streamOptions('conn-a'))
      .catch(() => undefined)
    await vi.waitFor(() => expect(handleMobileSubscribe).toHaveBeenCalledTimes(1))

    void dispatcher.dispatchStreaming(
      makeRequest(leaseOnlyParams),
      vi.fn(),
      streamOptions('conn-b')
    )
    await vi.waitFor(() => expect(handleMobileSubscribe).toHaveBeenCalledTimes(2))
    const live = registry.peekCleanup(SUBSCRIPTION_ID)

    failFirstSubscribe()
    await flush()

    expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBe(live)
  })

  it('does not let a legacy JSON snapshot resuming after a rebind retire the replacement', async () => {
    const registry = createSubscriptionRegistryDouble()
    const waiters: Waiter[] = []
    let releaseFirstRead = (): void => {}
    const readTerminal = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirstRead = () => resolve({ tail: [], truncated: false })
          })
      )
      .mockResolvedValue({ tail: [], truncated: false })
    const runtime = stubRuntime(registry, waiters, { readTerminal })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    void dispatcher.dispatchStreaming(makeRequest(legacyParams), vi.fn(), {
      connectionId: 'conn-a'
    })
    await vi.waitFor(() => expect(readTerminal).toHaveBeenCalledTimes(1))

    void dispatcher.dispatchStreaming(makeRequest(legacyParams), vi.fn(), {
      connectionId: 'conn-b'
    })
    await vi.waitFor(() => expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBeDefined())
    await vi.waitFor(() => expect(readTerminal).toHaveBeenCalledTimes(2))
    const live = registry.peekCleanup(SUBSCRIPTION_ID)

    releaseFirstRead()
    await flush()

    expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBe(live)
  })
})

describe('terminal.unsubscribe connection ownership', () => {
  const unsubscribeRequest = (subscriptionId: string): RpcRequest => ({
    id: 'req-unsub',
    authToken: 'tok',
    method: 'terminal.unsubscribe',
    params: { subscriptionId, client: { id: 'phone-1' } }
  })

  // T5 stale-connection: the make-before-break migration case.
  it('ignores an unsubscribe from a connection that no longer owns the subscription', async () => {
    const registry = createSubscriptionRegistryDouble()
    const waiters: Waiter[] = []
    const runtime = stubRuntime(registry, waiters)
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    void dispatcher.dispatchStreaming(makeRequest(binaryParams), vi.fn(), streamOptions('conn-a'))
    await vi.waitFor(() => expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBeDefined())
    void dispatcher.dispatchStreaming(makeRequest(binaryParams), vi.fn(), streamOptions('conn-b'))
    await flush()
    const live = registry.peekCleanup(SUBSCRIPTION_ID)
    expect(live).toBeDefined()

    const replies: string[] = []
    // Why dispatchStreaming: websocket requests route through it even for
    // non-streaming methods, and it is the only path that carries connectionId.
    await dispatcher.dispatchStreaming(
      unsubscribeRequest(SUBSCRIPTION_ID),
      (msg) => replies.push(msg),
      { connectionId: 'conn-a' }
    )
    await flush()

    expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBe(live)
    expect(JSON.parse(replies[0]!).result).toEqual({ unsubscribed: false })
  })

  // T5 same-connection: preservation — the owning connection may still unsubscribe.
  it('honors an unsubscribe from the connection that owns the subscription', async () => {
    const registry = createSubscriptionRegistryDouble()
    const waiters: Waiter[] = []
    const runtime = stubRuntime(registry, waiters)
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    void dispatcher.dispatchStreaming(makeRequest(binaryParams), vi.fn(), streamOptions('conn-a'))
    await vi.waitFor(() => expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBeDefined())

    const replies: string[] = []
    // Why dispatchStreaming: websocket requests route through it even for
    // non-streaming methods, and it is the only path that carries connectionId.
    await dispatcher.dispatchStreaming(
      unsubscribeRequest(SUBSCRIPTION_ID),
      (msg) => replies.push(msg),
      { connectionId: 'conn-a' }
    )
    await flush()

    expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBeUndefined()
    expect(JSON.parse(replies[0]!).result).toEqual({ unsubscribed: true })
  })
})
