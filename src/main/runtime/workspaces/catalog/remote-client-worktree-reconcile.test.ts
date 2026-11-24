import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteClientWorktreeReconcile } from './remote-client-worktree-reconcile'

describe('RemoteClientWorktreeReconcile', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports a change only after a baseline and only while a client is retained', async () => {
    vi.useFakeTimers()
    const repo = { id: 'repo-1' }
    let fingerprint = 'two-worktrees'
    const notifyChanged = vi.fn()
    const reconcile = new RemoteClientWorktreeReconcile({
      listProbeableRepos: () => [repo],
      probe: async () => fingerprint,
      notifyChanged,
      intervalMs: 1000
    })

    const release = reconcile.retain()
    await vi.advanceTimersByTimeAsync(0)
    expect(notifyChanged).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(notifyChanged).not.toHaveBeenCalled()

    fingerprint = 'one-worktree'
    await vi.advanceTimersByTimeAsync(1000)
    expect(notifyChanged).toHaveBeenCalledTimes(1)
    expect(notifyChanged).toHaveBeenCalledWith('repo-1')

    release()
    fingerprint = 'no-worktrees'
    await vi.advanceTimersByTimeAsync(5000)
    expect(notifyChanged).toHaveBeenCalledTimes(1)
  })
})
