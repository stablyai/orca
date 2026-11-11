import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal/terminal'
import '../../../shared/rpc-contract/terminal-viewport-schemas-params'
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

/** What a phone that addresses its request sends; the slot fields stay for older hosts. */
const phoneUnsubscribeParams = (requestId: string) => ({
  subscriptionId: SUBSCRIPTION_ID,
  client: { id: 'phone-1' },
  requestId
})
const requestUnsubscribe = (requestId: string): RpcRequest => ({
  id: `req-${++nextRequestId}`,
  authToken: 'tok',
  method: 'terminal.unsubscribe',
  params: phoneUnsubscribeParams(requestId)
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
    releaseSubscriptionByRequest: registry.releaseSubscriptionByRequest,
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
})

describe('terminal.unsubscribe addressed by request', () => {
  const liveStub = () => stubRuntime({ resolveLeafForHandle: vi.fn(() => ({ ptyId: PTY_ID })) })

  it('ends a subscribe still waiting for its pty, addressed by its request id', async () => {
    const { runtime, ptyWaits, spawn } = createRealRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const pending = subscribeRequest(binaryParams)
    const messages: string[] = []
    const subscribe = dispatcher.dispatchStreaming(
      pending,
      (message) => messages.push(message),
      phoneConnection('conn-a')
    )
    await vi.waitFor(() => expect(ptyWaits.waitForLeafPtyId).toHaveBeenCalled())

    await dispatcher.dispatchStreaming(requestUnsubscribe(pending.id), vi.fn(), {
      connectionId: 'conn-a'
    })
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

  it('never lets a back-to-back unsubscribe overtake the subscribe it names', async () => {
    const { runtime, registry } = liveStub()
    const register = vi.spyOn(runtime, 'registerOwnedSubscriptionCleanup')
    const release = vi.spyOn(runtime, 'releaseSubscriptionByRequest')
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const subscribe = subscribeRequest(binaryParams)
    const messages: string[] = []

    const streaming = dispatcher.dispatchStreaming(
      subscribe,
      (message) => messages.push(message),
      phoneConnection('conn-a')
    )
    const unsubscribing = dispatcher.dispatchStreaming(requestUnsubscribe(subscribe.id), vi.fn(), {
      connectionId: 'conn-a'
    })
    await Promise.all([streaming, unsubscribing])
    await flush()

    expect(register.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]!)
    expect(registry.peekCleanup(SUBSCRIPTION_ID)).toBeUndefined()
    expect(registry.requestAddressCount()).toBe(0)
    expect(resultTypes(messages).filter((type) => type === 'end')).toHaveLength(1)
  })

  it('heals a half-open socket: the replay on a new socket is what the leave ends', async () => {
    const { runtime, spawn } = createRealRuntime()
    spawn()
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    // Replay after a reconnect resends the same request id on the new socket.
    const replayed = subscribeRequest(binaryParams)
    const halfOpenMessages: string[] = []
    const halfOpen = dispatcher.dispatchStreaming(
      replayed,
      (message) => halfOpenMessages.push(message),
      phoneConnection('conn-1')
    )
    await vi.waitFor(() => expect(runtime.getDriver(PTY_ID).kind).toBe('mobile'))
    const replay = dispatcher.dispatchStreaming(replayed, vi.fn(), phoneConnection('conn-2'))
    await halfOpen
    expect(resultTypes(halfOpenMessages).at(-1)).toBe('end')

    await dispatcher.dispatchStreaming(requestUnsubscribe(replayed.id), vi.fn(), {
      connectionId: 'conn-2'
    })
    await replay

    await vi.waitFor(() => expect(runtime.getDriver(PTY_ID).kind).toBe('idle'), {
      timeout: 2_000
    })
    // The half-open socket's eventual close finds nothing of its own left.
    runtime.cleanupSubscriptionsForConnection('conn-1')
    expect(runtime.getDriver(PTY_ID).kind).toBe('idle')
  })
})
