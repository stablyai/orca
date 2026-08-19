import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

type RuntimeInternals = {
  recordPtyWorktree: (ptyId: string, worktreeId: string, state?: { connected?: boolean }) => unknown
  ptyExitListenersByPtyId: Map<string, Set<unknown>>
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

function registerLivePty(runtime: OrcaRuntimeService): void {
  internals(runtime).recordPtyWorktree('pty-1', 'wt-1', { connected: true })
}

describe('PTY exit subscription', () => {
  it('fires on the backing PTY exit', () => {
    const runtime = new OrcaRuntimeService()
    registerLivePty(runtime)
    const listener = vi.fn()

    runtime.subscribeToPtyExit('pty-1', listener)

    expect(internals(runtime).ptyExitListenersByPtyId.get('pty-1')).toHaveLength(1)

    runtime.onPtyExit('pty-1', 0)

    expect(listener).toHaveBeenCalledOnce()
    expect(internals(runtime).ptyExitListenersByPtyId.has('pty-1')).toBe(false)
  })

  it('does not retain listeners across subscription churn', () => {
    const runtime = new OrcaRuntimeService()
    registerLivePty(runtime)
    const listener = vi.fn()

    for (let index = 0; index < 25; index += 1) {
      runtime.subscribeToPtyExit('pty-1', listener)()
    }
    runtime.onPtyExit('pty-1', 0)

    expect(listener).not.toHaveBeenCalled()
    expect(internals(runtime).ptyExitListenersByPtyId.has('pty-1')).toBe(false)
  })

  it('fires immediately when the PTY already exited', () => {
    const runtime = new OrcaRuntimeService()
    registerLivePty(runtime)
    runtime.onPtyExit('pty-1', 0)
    const listener = vi.fn()

    runtime.subscribeToPtyExit('pty-1', listener)

    expect(listener).toHaveBeenCalledOnce()
    expect(internals(runtime).ptyExitListenersByPtyId.has('pty-1')).toBe(false)
  })
})
