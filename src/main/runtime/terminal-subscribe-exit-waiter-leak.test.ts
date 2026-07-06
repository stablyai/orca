/**
 * Memory-leak regression: terminal.subscribe / terminal.multiplex register a
 * runtime exit-waiter (waitForTerminal condition:'exit') per subscribed slot.
 * Without an AbortSignal that waiter is only removed on real PTY exit, so for a
 * never-exiting agent terminal every remote/mobile reconnect and tab-switch
 * re-subscribe leaked a waiter (and the closed-connection handler context it
 * captures). The subscribe paths now pass a signal — this pins that a signalled
 * exit-waiter is released when the signal aborts, and an unsignalled one is not.
 */
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeTerminalWait } from '../../shared/runtime-types'

type RuntimeInternals = {
  recordPtyWorktree: (ptyId: string, worktreeId: string, state?: { connected?: boolean }) => unknown
  handleByPtyId: Map<string, string>
  waitersByHandle: Map<string, Set<unknown>>
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

// Register a live, connected PTY that a handle resolves to, so waitForTerminal
// with condition:'exit' registers a pending waiter instead of resolving early.
function registerLivePty(runtime: OrcaRuntimeService, ptyId: string, handle: string): void {
  internals(runtime).recordPtyWorktree(ptyId, 'wt-live', { connected: true })
  internals(runtime).handleByPtyId.set(ptyId, handle)
}

function waiterCount(runtime: OrcaRuntimeService, handle: string): number {
  return internals(runtime).waitersByHandle.get(handle)?.size ?? 0
}

describe('terminal.subscribe exit-waiter leak regression', () => {
  it('releases a signalled exit-waiter when the signal aborts', async () => {
    const runtime = new OrcaRuntimeService()
    registerLivePty(runtime, 'pty-live', 'handle-live')

    const controller = new AbortController()
    const wait = runtime.waitForTerminal('handle-live', {
      condition: 'exit',
      signal: controller.signal
    })
    // Swallow the abort rejection; we assert on the waiter set, not the result.
    const settled: Promise<RuntimeTerminalWait | 'aborted'> = wait.catch(() => 'aborted' as const)
    await Promise.resolve()

    expect(waiterCount(runtime, 'handle-live')).toBe(1)

    // Simulate detachStream / connection close aborting the slot's controller.
    controller.abort()
    await expect(settled).resolves.toBe('aborted')

    expect(waiterCount(runtime, 'handle-live')).toBe(0)
  })

  it('leaks an unsignalled exit-waiter across reconnects (documents the bug the fix prevents)', async () => {
    const runtime = new OrcaRuntimeService()
    registerLivePty(runtime, 'pty-live', 'handle-live')

    // Three subscribes with no signal, as the pre-fix subscribe paths did.
    for (let i = 0; i < 3; i += 1) {
      void runtime.waitForTerminal('handle-live', { condition: 'exit' }).catch(() => {})
    }
    await Promise.resolve()

    // Nothing frees them short of real PTY exit — they accumulate.
    expect(waiterCount(runtime, 'handle-live')).toBe(3)
  })

  it('does not leak when many signalled subscribes churn (reconnect simulation)', async () => {
    const runtime = new OrcaRuntimeService()
    registerLivePty(runtime, 'pty-live', 'handle-live')

    for (let i = 0; i < 25; i += 1) {
      const controller = new AbortController()
      const settled = runtime
        .waitForTerminal('handle-live', { condition: 'exit', signal: controller.signal })
        .catch(() => 'aborted' as const)
      await Promise.resolve()
      controller.abort()
      await settled
    }

    expect(waiterCount(runtime, 'handle-live')).toBe(0)
  })
})
