// Why: the stale-handle survival suite doubles subscribeToPtyExit, so it pins the wiring but
// not the predicate that decides whether a PTY counts as exited. This wires that one call to
// a real OrcaRuntimeService, because a relay drop reaches the phone through the predicate.
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

const PTY_ID = 'pty-1'

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
    params: { terminal: 'terminal-1', client: { id: 'desktop-1', type: 'desktop' } }
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

type PtyInternals = {
  recordPtyWorktree: (ptyId: string, worktreeId: string, state?: { connected?: boolean }) => unknown
  ptysById: Map<string, { connected: boolean; lastExitCode: number | null }>
}

/** A PTY whose relay dropped: connection lost, no exit code, process possibly still running. */
function makeRelayDroppedRuntime(): OrcaRuntimeService {
  const real = new OrcaRuntimeService()
  const internals = real as unknown as PtyInternals
  internals.recordPtyWorktree(PTY_ID, 'wt-1', { connected: true })
  const pty = internals.ptysById.get(PTY_ID)!
  pty.connected = false
  expect(pty.lastExitCode).toBeNull()
  return real
}

function createRuntime(real: OrcaRuntimeService): {
  registry: ReturnType<typeof createSubscriptionRegistryDouble>
  runtime: OrcaRuntimeService
} {
  const registry = createSubscriptionRegistryDouble()
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    requestRendererTerminalTabMount: () => false,
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: PTY_ID }),
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
    // The one call under test: the real exit predicate, not a double's opinion of it.
    subscribeToPtyExit: (ptyId: string, listener: () => void) =>
      real.subscribeToPtyExit(ptyId, listener)
  } as unknown as OrcaRuntimeService
  return { registry, runtime }
}

function makeRequest(params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method: 'terminal.subscribe', params }
}

describe('terminal subscribe when the relay dropped without an exit code', () => {
  it.each(subscriptionCases)(
    'does not end $name for a process that may still be running',
    async ({ params }) => {
      const real = makeRelayDroppedRuntime()
      const { registry, runtime } = createRuntime(real)
      const messages: string[] = []
      const types = (): unknown[] => messages.map((message) => JSON.parse(message).result?.type)

      void new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
        .dispatchStreaming(makeRequest(params), (message) => messages.push(message), {
          connectionId: 'conn-1',
          sendBinary: vi.fn(),
          registerBinaryStreamHandler: vi.fn(() => vi.fn())
        })
        .catch(() => undefined)

      const subscriptionId = `terminal-1:${params.client.id}`
      await vi.waitFor(() => expect(registry.peekCleanup(subscriptionId)).toBeDefined())
      expect(types()).not.toContain('end')

      // The host comes back and reports the real exit; only now may the lease retire.
      real.onPtyExit(PTY_ID, 0)

      await vi.waitFor(() => expect(registry.peekCleanup(subscriptionId)).toBeUndefined())
      expect(types()).toContain('end')
    }
  )
})
