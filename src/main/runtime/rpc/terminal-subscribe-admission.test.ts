import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

const PTY_ID = 'pty-1'
const SUBSCRIPTION_ID = 'terminal-1:phone-1'

const binaryParams = {
  terminal: 'terminal-1',
  client: { id: 'phone-1', type: 'mobile' },
  viewport: { cols: 40, rows: 20 },
  capabilities: { terminalBinaryStream: 1 }
}

const leaseOnlyParams = {
  terminal: 'terminal-1',
  client: { id: 'phone-1', type: 'mobile' },
  capabilities: { terminalBinaryStream: 1, mobileInputLeaseOnly: 1 }
}

let nextRequestId = 0
const subscribeRequest = (params: unknown): RpcRequest => ({
  id: `req-${++nextRequestId}`,
  authToken: 'tok',
  method: 'terminal.subscribe',
  params
})
const unsubscribeRequest = (): RpcRequest => ({
  id: `req-${++nextRequestId}`,
  authToken: 'tok',
  method: 'terminal.unsubscribe',
  params: { subscriptionId: SUBSCRIPTION_ID }
})

const phoneConnection = (connectionId: string, signal?: AbortSignal) => ({
  connectionId,
  signal,
  sendBinary: vi.fn(),
  registerBinaryStreamHandler: vi.fn(() => vi.fn())
})

const resultTypes = (messages: string[]): unknown[] =>
  messages.map((message) => JSON.parse(message).result?.type)

const flush = (ms = 20): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, ms))

/** Resolves pending `waitForLeafPtyId` calls on demand and rejects them when their signal aborts, like the runtime. */
function createPtyWaits() {
  const waits: { resolve: (ptyId: string) => void }[] = []
  return {
    waits,
    waitForLeafPtyId: vi.fn(
      (_handle: string, _timeoutMs?: number, signal?: AbortSignal) =>
        new Promise<string>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error('request_aborted'))
            return
          }
          signal?.addEventListener('abort', () => reject(new Error('request_aborted')), {
            once: true
          })
          waits.push({ resolve })
        })
    ),
    spawn: () => {
      for (const wait of waits.splice(0)) {
        wait.resolve(PTY_ID)
      }
    }
  }
}

function stubRuntime(overrides: Record<string, unknown> = {}) {
  const registry = createSubscriptionRegistryDouble()
  const ptyWaits = createPtyWaits()
  let ptyReady = false
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This partial runtime supplies the terminal RPC methods these tests invoke.
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    registerRemoteTerminalViewSubscriber: () => () => {},
    requestRendererTerminalTabMount: vi.fn(() => false),
    resolveLeafForHandle: vi.fn(() => ({ ptyId: ptyReady ? PTY_ID : null })),
    waitForLeafPtyId: ptyWaits.waitForLeafPtyId,
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn(),
    subscribeToTerminalData: vi.fn(() => vi.fn()),
    readTerminal: vi.fn().mockResolvedValue({ tail: ['scrollback'], truncated: false }),
    serializeTerminalBuffer: vi
      .fn()
      .mockResolvedValue({ data: 'snapshot', cols: 40, rows: 20, seq: 4 }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 40, rows: 20 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
    subscribeToTerminalResize: vi.fn(() => vi.fn()),
    subscribeToFitOverrideChanges: vi.fn(() => vi.fn()),
    subscribeToPtyExit: vi.fn(() => vi.fn()),
    registerOwnedSubscriptionCleanup: registry.registerOwnedSubscriptionCleanup,
    cleanupSubscriptionIfOwnedByConnection: registry.cleanupSubscriptionIfOwnedByConnection,
    getSubscriptionRegistrationVersion: registry.getSubscriptionRegistrationVersion,
    ...overrides
  } as unknown as OrcaRuntimeService
  const spawn = (): void => {
    ptyReady = true
    ptyWaits.spawn()
  }
  return { runtime, registry, ptyWaits, spawn }
}

/** The real runtime, with only handle resolution, the pty wait, the scrollback read and tab mounting doubled. */
function createRealRuntime() {
  const runtime = new OrcaRuntimeService()
  const sizes = new Map<string, { cols: number; rows: number }>([[PTY_ID, { cols: 120, rows: 40 }]])
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    resize: (ptyId, cols, rows) => {
      sizes.set(ptyId, { cols, rows })
      return true
    },
    getSize: (ptyId) => sizes.get(ptyId) ?? null
  })
  const ptyWaits = createPtyWaits()
  let ptyReady = false
  vi.spyOn(runtime, 'resolveLeafForHandle').mockImplementation(() => ({
    ptyId: ptyReady ? PTY_ID : null
  }))
  vi.spyOn(runtime, 'waitForLeafPtyId').mockImplementation(ptyWaits.waitForLeafPtyId)
  vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
    handle: 'terminal-1',
    status: 'running',
    tail: [],
    truncated: false,
    nextCursor: null
  })
  vi.spyOn(runtime, 'requestRendererTerminalTabMount').mockReturnValue(false)
  const spawn = (): void => {
    ptyReady = true
    ptyWaits.spawn()
  }
  return { runtime, ptyWaits, spawn, sizes }
}

describe('terminal.subscribe registers at admission', () => {
  it('lets an unsubscribe end a subscribe that is still waiting for its pty', async () => {
    const { runtime, registry, ptyWaits, spawn } = stubRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const messages: string[] = []
    const subscribe = dispatcher.dispatchStreaming(
      subscribeRequest(binaryParams),
      (message) => messages.push(message),
      phoneConnection('conn-a')
    )
    await vi.waitFor(() => expect(ptyWaits.waitForLeafPtyId).toHaveBeenCalled())

    const replies: string[] = []
    await dispatcher.dispatchStreaming(unsubscribeRequest(), (reply) => replies.push(reply), {
      connectionId: 'conn-a'
    })
    spawn()
    await flush()

    try {
      expect(JSON.parse(replies[0]!).result).toEqual({ unsubscribed: true })
      expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBeUndefined()
      expect(runtime.handleMobileSubscribe).not.toHaveBeenCalled()
      expect(resultTypes(messages)).toEqual(['end'])
    } finally {
      registry.cleanupSubscriptionsForConnection('conn-a')
      await subscribe
    }
  })

  it('leaves the desktop driver idle when the phone leaves before the pty is ready', async () => {
    const { runtime, ptyWaits, spawn } = createRealRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const messages: string[] = []
    const subscribe = dispatcher.dispatchStreaming(
      subscribeRequest(binaryParams),
      (message) => messages.push(message),
      phoneConnection('conn-a')
    )
    await vi.waitFor(() => expect(ptyWaits.waitForLeafPtyId).toHaveBeenCalled())

    await dispatcher.dispatchStreaming(unsubscribeRequest(), vi.fn(), { connectionId: 'conn-a' })
    spawn()
    await flush()

    try {
      expect(runtime.getDriver(PTY_ID).kind).toBe('idle')
      expect(runtime.getTerminalFitOverride(PTY_ID)).toBeNull()
      expect(resultTypes(messages)).toEqual(['end'])
    } finally {
      runtime.cleanupSubscriptionsForConnection('conn-a')
      await subscribe
    }
  })

  it('ends a pending subscribe replaced by the same slot without adding its presence', async () => {
    const { runtime, registry, ptyWaits, spawn } = stubRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const firstMessages: string[] = []
    const first = dispatcher.dispatchStreaming(
      subscribeRequest(binaryParams),
      (message) => firstMessages.push(message),
      phoneConnection('conn-a')
    )
    await vi.waitFor(() => expect(ptyWaits.waitForLeafPtyId).toHaveBeenCalledTimes(1))

    const second = dispatcher.dispatchStreaming(
      subscribeRequest(binaryParams),
      vi.fn(),
      phoneConnection('conn-b')
    )
    await vi.waitFor(() => expect(ptyWaits.waitForLeafPtyId).toHaveBeenCalledTimes(2))
    const replacement = registry.peekCleanup(SUBSCRIPTION_ID)
    spawn()
    await first
    await vi.waitFor(() => expect(runtime.handleMobileSubscribe).toHaveBeenCalled())
    await flush()

    try {
      expect(resultTypes(firstMessages)).toEqual(['end'])
      // Only the replacement joins; the evicted request never adds presence behind it.
      expect(runtime.handleMobileSubscribe).toHaveBeenCalledOnce()
      expect(runtime.handleMobileUnsubscribe).not.toHaveBeenCalled()
      expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBe(replacement)
    } finally {
      registry.cleanupSubscriptionsForConnection('conn-b')
      await second
    }
  })

  it('leaves the desktop driver idle when the phone leaves during the phone-fit layout', async () => {
    const { runtime, sizes } = createRealRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    let leaveDuringLayout = true
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      resize: (ptyId, cols, rows) => {
        sizes.set(ptyId, { cols, rows })
        // The phone's unsubscribe lands while handleMobileSubscribe awaits its layout.
        if (leaveDuringLayout) {
          leaveDuringLayout = false
          runtime.cleanupSubscriptionIfOwnedByConnection(SUBSCRIPTION_ID, 'conn-a')
        }
        return true
      },
      getSize: (ptyId) => sizes.get(ptyId) ?? null
    })
    vi.spyOn(runtime, 'resolveLeafForHandle').mockReturnValue({ ptyId: PTY_ID })
    const messages: string[] = []

    const subscribe = dispatcher.dispatchStreaming(
      subscribeRequest(binaryParams),
      (message) => messages.push(message),
      phoneConnection('conn-a')
    )
    await vi.waitFor(() => expect(leaveDuringLayout).toBe(false))
    await subscribe

    await vi.waitFor(() => expect(runtime.getDriver(PTY_ID).kind).toBe('idle'), {
      timeout: 2_000
    })
    expect(resultTypes(messages)).toEqual(['end'])
  })

  it('leaves no registration when the request aborts while the pty is pending', async () => {
    const { runtime, registry, ptyWaits, spawn } = stubRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const request = new AbortController()
    const messages: string[] = []
    const subscribe = dispatcher.dispatchStreaming(
      subscribeRequest(binaryParams),
      (message) => messages.push(message),
      phoneConnection('conn-a', request.signal)
    )
    await vi.waitFor(() => expect(ptyWaits.waitForLeafPtyId).toHaveBeenCalled())

    request.abort()
    spawn()
    await subscribe
    await flush()

    expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBeUndefined()
    expect(runtime.handleMobileSubscribe).not.toHaveBeenCalled()
    expect(runtime.subscribeToTerminalData).not.toHaveBeenCalled()
    expect(resultTypes(messages)).toEqual(['end'])
  })

  it('does not follow a released stream end with an error', async () => {
    let rejectSubscribe = (_error: Error): void => {}
    const { runtime, registry } = stubRuntime({
      resolveLeafForHandle: vi.fn(() => ({ ptyId: PTY_ID })),
      handleMobileSubscribe: vi.fn(
        () =>
          new Promise<boolean>((_resolve, reject) => {
            rejectSubscribe = reject
          })
      )
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const messages: string[] = []
    const subscribe = dispatcher.dispatchStreaming(
      subscribeRequest(leaseOnlyParams),
      (message) => messages.push(message),
      phoneConnection('conn-a')
    )
    await vi.waitFor(() => expect(runtime.handleMobileSubscribe).toHaveBeenCalled())

    registry.cleanupSubscriptionIfOwnedByConnection(SUBSCRIPTION_ID, 'conn-a')
    rejectSubscribe(new Error('subscribe_failed'))
    await subscribe

    expect(messages.map((message) => JSON.parse(message))).toEqual([
      expect.objectContaining({ ok: true, result: { type: 'end' } })
    ])
  })

  it('fails without end when the stream errors before anything released it', async () => {
    const { runtime, registry } = stubRuntime({
      resolveLeafForHandle: vi.fn(() => ({ ptyId: PTY_ID })),
      handleMobileSubscribe: vi.fn().mockRejectedValue(new Error('subscribe_failed'))
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      subscribeRequest(leaseOnlyParams),
      (message) => messages.push(message),
      phoneConnection('conn-a')
    )

    expect(messages.map((message) => JSON.parse(message).ok)).toEqual([false])
    expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBeUndefined()
    // Presence was added before the await, so the failed request still removes it.
    expect(runtime.handleMobileUnsubscribe).toHaveBeenCalledWith(PTY_ID, 'phone-1')
  })
})

describe('terminal.subscribe characterization', () => {
  it('answers a dead pty with a scrollback preview, then one end, and keeps no registration', async () => {
    const { runtime, registry } = stubRuntime({
      waitForLeafPtyId: vi.fn().mockRejectedValue(new Error('Timed out waiting for PTY to spawn'))
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const messages: string[] = []

    await dispatcher.dispatchStreaming(
      subscribeRequest(binaryParams),
      (message) => messages.push(message),
      phoneConnection('conn-a')
    )

    expect(runtime.waitForLeafPtyId).toHaveBeenCalled()
    expect(messages.map((message) => JSON.parse(message).result)).toEqual([
      { type: 'subscribed', streamId: null, lines: ['scrollback'], truncated: false },
      { type: 'end' }
    ])
    expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBeUndefined()
  })

  it('stops listening to a long-lived IPC signal once the stream is released', async () => {
    const { runtime, registry } = stubRuntime({
      resolveLeafForHandle: vi.fn(() => ({ ptyId: PTY_ID }))
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    // IPC keeps one controller per subscription id and it outlives the dispatch.
    const ipcSubscription = new AbortController()
    const addAbort = vi.spyOn(ipcSubscription.signal, 'addEventListener')
    const removeAbort = vi.spyOn(ipcSubscription.signal, 'removeEventListener')
    const messages: string[] = []
    const subscribe = dispatcher.dispatchStreaming(
      subscribeRequest(binaryParams),
      (message) => messages.push(message),
      { ...phoneConnection('ipc-a'), signal: ipcSubscription.signal }
    )
    await vi.waitFor(() => expect(runtime.handleMobileSubscribe).toHaveBeenCalled())
    expect(addAbort).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })

    registry.cleanupSubscriptionIfOwnedByConnection(SUBSCRIPTION_ID, 'ipc-a')
    await subscribe
    expect(removeAbort).toHaveBeenCalledWith('abort', addAbort.mock.calls[0]![1])

    ipcSubscription.abort()
    await flush()
    expect(runtime.handleMobileUnsubscribe).toHaveBeenCalledOnce()
    expect(resultTypes(messages).filter((type) => type === 'end')).toHaveLength(1)
  })

  it('ends a stream when its IPC subscription is aborted', async () => {
    const { runtime, registry } = stubRuntime({
      resolveLeafForHandle: vi.fn(() => ({ ptyId: PTY_ID }))
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const ipcSubscription = new AbortController()
    const messages: string[] = []
    const subscribe = dispatcher.dispatchStreaming(
      subscribeRequest(binaryParams),
      (message) => messages.push(message),
      { ...phoneConnection('ipc-a'), signal: ipcSubscription.signal }
    )
    await vi.waitFor(() => expect(runtime.handleMobileSubscribe).toHaveBeenCalled())

    ipcSubscription.abort()
    await subscribe

    expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBeUndefined()
    expect(runtime.handleMobileUnsubscribe).toHaveBeenCalledWith(PTY_ID, 'phone-1')
    expect(resultTypes(messages).at(-1)).toBe('end')
  })

  it('rejects a phone without binary streaming before it can replace the live stream', async () => {
    const { runtime, registry } = stubRuntime({
      waitForLeafPtyId: vi.fn().mockRejectedValue(new Error('Timed out waiting for PTY to spawn'))
    })
    const live = vi.fn()
    registry.registerOwnedSubscriptionCleanup(SUBSCRIPTION_ID, live, 'conn-a')
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const messages: string[] = []

    // A pre-binary phone subscribing to a pty that never spawned: this used to get a preview and end.
    await dispatcher.dispatchStreaming(
      subscribeRequest({ terminal: 'terminal-1', client: { id: 'phone-1', type: 'mobile' } }),
      (message) => messages.push(message),
      { connectionId: 'conn-b' }
    )

    expect(JSON.parse(messages[0]!)).toMatchObject({
      ok: false,
      error: { message: 'binary_terminal_stream_required' }
    })
    expect(messages).toHaveLength(1)
    expect(runtime.waitForLeafPtyId).not.toHaveBeenCalled()
    expect(live).not.toHaveBeenCalled()
    expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBe(live)
  })
})
