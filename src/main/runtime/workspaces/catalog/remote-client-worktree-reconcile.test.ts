import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteClientWorktreeReconcile } from './remote-client-worktree-reconcile'

describe('RemoteClientWorktreeReconcile', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('never carries a baseline or an in-flight probe across a gap with no clients', async () => {
    vi.useFakeTimers()
    let fingerprint = 'one'
    const held: { resolve?: (value: string) => void } = {}
    let holdNext = false
    const notifyChanged = vi.fn()
    const reconcile = new RemoteClientWorktreeReconcile<{ id: string }>({
      listProbeableRepos: () => [{ id: 'repo-1' }],
      probe: () => {
        if (holdNext) {
          holdNext = false
          return new Promise<string>((resolve) => (held.resolve = resolve))
        }
        return Promise.resolve(fingerprint)
      },
      notifyChanged,
      intervalMs: 1000
    })

    const releaseFirst = reconcile.retain()
    await vi.advanceTimersByTimeAsync(0)
    releaseFirst()
    fingerprint = 'two'
    const releaseSecond = reconcile.retain()
    await vi.advanceTimersByTimeAsync(1000)
    expect(notifyChanged).not.toHaveBeenCalled()

    releaseSecond()
    holdNext = true
    reconcile.retain()()
    reconcile.retain()
    held.resolve?.('stale-before-gap')
    await vi.advanceTimersByTimeAsync(2000)
    expect(notifyChanged).not.toHaveBeenCalled()
  })
})
