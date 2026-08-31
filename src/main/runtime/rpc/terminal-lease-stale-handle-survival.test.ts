import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

type ExitListener = () => void

const subscriptionCases = [
  {
    name: 'lease-only',
    params: {
      terminal: 'terminal-1',
      client: { id: 'phone-1', type: 'mobile' },
      capabilities: { terminalBinaryStream: 1, mobileInputLeaseOnly: 1 }
    }
  },
  {
    name: 'legacy JSON',
    params: {
      terminal: 'terminal-1',
      client: { id: 'desktop-1', type: 'desktop' }
    }
  },
  {
    name: 'binary',
    params: {
      terminal: 'terminal-1',
      client: { id: 'phone-1', type: 'mobile' },
      capabilities: { terminalBinaryStream: 1 }
    }
  }
] as const

function createRuntime(exitListeners: ExitListener[]) {
  const registry = createSubscriptionRegistryDouble()
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    requestRendererTerminalTabMount: () => false,
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn(),
    registerRemoteTerminalViewSubscriber: vi.fn(() => vi.fn()),
    subscribeToTerminalData: vi.fn(() => vi.fn()),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi
      .fn()
      .mockResolvedValue({ data: 'snapshot', cols: 80, rows: 24, seq: 1 }),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
    subscribeToTerminalResize: vi.fn(() => vi.fn()),
    subscribeToFitOverrideChanges: vi.fn(() => vi.fn()),
    registerSubscriptionCleanup: vi.fn(registry.registerSubscriptionCleanup),
    registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
    cleanupSubscription: vi.fn(registry.cleanupSubscription),
    waitForTerminal: vi.fn(() => Promise.reject(new Error('unexpected handle waiter'))),
    subscribeToPtyExit: vi.fn((_ptyId: string, listener: ExitListener) => {
      exitListeners.push(listener)
      return vi.fn()
    })
  } as unknown as OrcaRuntimeService
  return { registry, runtime }
}

function makeRequest(params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'terminal.subscribe', params }
}

describe('terminal subscribe after a handle becomes stale', () => {
  it.each(subscriptionCases)(
    'keeps $name alive until the backing PTY exits',
    async ({ params }) => {
      const exitListeners: ExitListener[] = []
      const { registry, runtime } = createRuntime(exitListeners)
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
      const messages: string[] = []

      void dispatcher
        .dispatchStreaming(makeRequest(params), (message) => messages.push(message), {
          connectionId: 'conn-1',
          sendBinary: vi.fn(),
          registerBinaryStreamHandler: vi.fn(() => vi.fn())
        })
        .catch(() => undefined)

      await vi.waitFor(() => expect(exitListeners).toHaveLength(1))
      const subscriptionId = `terminal-1:${params.client.id}`
      await vi.waitFor(() => expect(registry.peekCleanup(subscriptionId)).toBeDefined())

      vi.mocked(runtime.resolveLeafForHandle).mockImplementation(() => {
        throw new Error('terminal_handle_stale')
      })
      await Promise.resolve()

      expect(registry.peekCleanup(subscriptionId)).toBeDefined()
      expect(messages.map((message) => JSON.parse(message).result?.type)).not.toContain('end')
      expect(runtime.waitForTerminal).not.toHaveBeenCalled()

      exitListeners[0]!()

      await vi.waitFor(() => expect(registry.peekCleanup(subscriptionId)).toBeUndefined())
      expect(messages.map((message) => JSON.parse(message).result?.type)).toContain('end')
    }
  )
})
