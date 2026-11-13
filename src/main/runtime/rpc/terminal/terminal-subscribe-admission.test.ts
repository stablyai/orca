import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { TERMINAL_METHODS } from '../methods/terminal/terminal'
import '../../../../shared/rpc-contract/terminal/terminal-viewport-schemas-params'

const PTY_ID = 'pty-1'
const SUBSCRIPTION_ID = 'terminal-1:phone-1'

const binaryParams = {
  terminal: 'terminal-1',
  client: { id: 'phone-1', type: 'mobile' },
  viewport: { cols: 40, rows: 20 },
  capabilities: { terminalBinaryStream: 1 }
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
})

describe('terminal.unsubscribe addressed by request', () => {
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
