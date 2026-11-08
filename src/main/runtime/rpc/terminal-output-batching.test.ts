import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'
import type { RuntimeTerminalWait } from '../../../shared/runtime-terminal-contracts'
import '../../../shared/terminal/stream/terminal-stream-protocol'

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    subscribeToPtyExit: vi.fn(() => vi.fn()),
    // Why: subscribe streams register as remote view subscribers for Phase-5
    registerRemoteTerminalViewSubscriber: () => () => {},
    ...overrides
  } as OrcaRuntimeService
}

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('terminal output batching', () => {
  it('coalesces desktop terminal output bursts before emitting stream data', async () => {
    vi.useFakeTimers()
    try {
      const messages: string[] = []
      const registry = createSubscriptionRegistryDouble()
      const dataListenerRef: { current?: (data: string) => void } = {}
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn((_: string, listener: (data: string) => void) => {
          dataListenerRef.current = listener
          return vi.fn()
        }),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
        registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
        cleanupSubscription: vi.fn(registry.cleanupSubscription),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
      })
      const dispatcher = new RpcDispatcher({
        runtime,
        methods: TERMINAL_METHODS
      })

      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.subscribe', {
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' }
        }),
        (msg) => messages.push(msg)
      )

      await vi.waitFor(() => expect(dataListenerRef.current).toBeDefined())
      const emitData = dataListenerRef.current
      if (!emitData) {
        throw new Error('missing terminal data listener')
      }
      emitData('a')
      emitData('b')

      expect(messages.map((msg) => JSON.parse(msg).result?.type)).not.toContain('data')

      await vi.runOnlyPendingTimersAsync()

      const dataMessages = messages
        .map((msg) => JSON.parse(msg))
        .filter((message) => message.result?.type === 'data')
      expect(dataMessages).toHaveLength(1)
      expect(dataMessages[0]).toMatchObject({
        result: { type: 'data', chunk: 'ab' }
      })

      runtime.cleanupSubscription('terminal-1:desktop-1')
      await dispatchPromise
    } finally {
      vi.useRealTimers()
    }
  })
})
