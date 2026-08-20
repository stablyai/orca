import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame
} from '../../../shared/terminal-stream-protocol'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

const makeRequest = (params: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method: 'terminal.subscribe',
  params
})

const subscribeParams = {
  terminal: 'terminal-1',
  client: { id: 'phone-1', type: 'mobile' },
  capabilities: { terminalBinaryStream: 1 }
}

describe('terminal.subscribe reconnect rebind (STA-4510)', () => {
  it('keeps the rebound live stream when the pre-reconnect connection aborts', async () => {
    const registry = createSubscriptionRegistryDouble()
    const dataListeners: ((data: string, meta?: { seq?: number; rawLength?: number }) => void)[] =
      []

    const runtime = {
      getRuntimeId: () => 'test-runtime',
      subscribeToPtyExit: vi.fn(() => vi.fn()),
      registerRemoteTerminalViewSubscriber: () => () => {},
      requestRendererTerminalTabMount: () => false,
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      handleMobileSubscribe: vi.fn().mockResolvedValue(true),
      handleMobileUnsubscribe: vi.fn(),
      subscribeToTerminalData: vi.fn((_ptyId: string, listener: (typeof dataListeners)[number]) => {
        dataListeners.push(listener)
        return vi.fn()
      }),
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
      cleanupSubscription: vi.fn(registry.cleanupSubscription),
      registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
      // Mirrors bindTerminalWaiterAbort (orca-runtime.ts:34183): abort rejects.
      waitForTerminal: vi.fn(
        (_handle: string, options?: { signal?: AbortSignal }) =>
          new Promise<RuntimeTerminalWait>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('request_aborted')), {
              once: true
            })
          })
      )
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    // --- connection A: the original mobile socket -------------------------
    const connA = new AbortController()
    void dispatcher.dispatchStreaming(makeRequest(subscribeParams), vi.fn(), {
      signal: connA.signal,
      connectionId: 'conn-a',
      sendBinary: vi.fn(),
      registerBinaryStreamHandler: vi.fn(() => vi.fn())
    })
    await vi.waitFor(() => expect(dataListeners).toHaveLength(1))

    // --- connection B: the reconnect re-sends subscribe, no unsubscribe ----
    const connB = new AbortController()
    const framesB: Uint8Array<ArrayBufferLike>[] = []
    void dispatcher.dispatchStreaming(makeRequest(subscribeParams), vi.fn(), {
      signal: connB.signal,
      connectionId: 'conn-b',
      sendBinary: (bytes) => {
        framesB.push(bytes)
      },
      registerBinaryStreamHandler: vi.fn(() => vi.fn())
    })
    await vi.waitFor(() => expect(dataListeners).toHaveLength(2))
    const liveListener = dataListeners[1]

    // Control: the rebound stream delivers output before the old socket is reaped.
    await new Promise((resolve) => setTimeout(resolve, 50))
    framesB.length = 0
    liveListener('before\r\n', { seq: 1, rawLength: 8 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(
      framesB.some((b) => decodeTerminalStreamFrame(b)?.opcode === TerminalStreamOpcode.Output)
    ).toBe(true)

    // A's own cleanup already ran at rebind time; nothing more may fire after.
    const unsubscribesAfterRebind = vi.mocked(runtime.handleMobileUnsubscribe).mock.calls.length

    // --- the half-open socket A is finally detected and closed ------------
    // runtime-rpc.ts:1339-1341 aborts dispatches first, then sweeps the conn.
    connA.abort()
    registry.cleanupSubscriptionsForConnection('conn-a')
    await new Promise((resolve) => setTimeout(resolve, 0))

    // --- the live (rebound) stream must survive ---------------------------
    framesB.length = 0
    liveListener('after\r\n', { seq: 2, rawLength: 7 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(
      framesB.some((b) => decodeTerminalStreamFrame(b)?.opcode === TerminalStreamOpcode.Output)
    ).toBe(true)
    expect(vi.mocked(runtime.handleMobileUnsubscribe).mock.calls.length).toBe(
      unsubscribesAfterRebind
    )
  })
})
