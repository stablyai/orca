import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const PTY_ID = 'repo::/tmp/exit-record-wait@@pty'
const WORKTREE_ID = 'repo::/tmp/exit-record-wait'

afterEach(() => {
  vi.useRealTimers()
})

describe('waitForPtyExitRecord', () => {
  it('resolves true once the exit reaches the runtime record', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.registerPty(PTY_ID, WORKTREE_ID, null)
    const wait = runtime.waitForPtyExitRecord(PTY_ID, 10_000)
    runtime.onPtyExit(PTY_ID, 0)
    await expect(wait).resolves.toBe(true)
    expect(runtime.getPtyLivenessVerdict(PTY_ID)).toEqual({ status: 'exited' })
  })

  it('resolves false when no exit arrives within the budget', async () => {
    vi.useFakeTimers()
    const runtime = new OrcaRuntimeService()
    runtime.registerPty(PTY_ID, WORKTREE_ID, null)
    const wait = runtime.waitForPtyExitRecord(PTY_ID, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(wait).resolves.toBe(false)
    runtime.onPtyExit(PTY_ID, 0)
  })

  it('does not wait for a PTY the runtime never registered or already saw exit', async () => {
    const runtime = new OrcaRuntimeService()
    await expect(runtime.waitForPtyExitRecord('unknown-pty', 10_000)).resolves.toBe(true)
    runtime.registerPty(PTY_ID, WORKTREE_ID, null)
    runtime.onPtyExit(PTY_ID, 0)
    await expect(runtime.waitForPtyExitRecord(PTY_ID, 10_000)).resolves.toBe(true)
  })
})
