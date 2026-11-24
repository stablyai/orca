import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteClientWorktreeReconcile } from './remote-client-worktree-reconcile'

type Repo = { id: string }

function create(deps: {
  repos: () => Repo[]
  probe: (repo: Repo) => Promise<string | null>
  notifyChanged?: (repoId: string) => void
  probeTimeoutMs?: number
}) {
  const notifyChanged = vi.fn(deps.notifyChanged ?? (() => {}))
  const reconcile = new RemoteClientWorktreeReconcile<Repo>({
    listProbeableRepos: deps.repos,
    probe: deps.probe,
    notifyChanged,
    intervalMs: 1000,
    probeTimeoutMs: deps.probeTimeoutMs
  })
  return { reconcile, notifyChanged }
}

describe('RemoteClientWorktreeReconcile', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reports a change only after a baseline and only while a client is retained', async () => {
    vi.useFakeTimers()
    let fingerprint = 'two-worktrees'
    const { reconcile, notifyChanged } = create({
      repos: () => [{ id: 'repo-1' }],
      probe: async () => fingerprint
    })

    const release = reconcile.retain()
    await vi.advanceTimersByTimeAsync(1000)
    expect(notifyChanged).not.toHaveBeenCalled()

    fingerprint = 'one-worktree'
    await vi.advanceTimersByTimeAsync(1000)
    expect(notifyChanged).toHaveBeenCalledExactlyOnceWith('repo-1')

    release()
    fingerprint = 'no-worktrees'
    await vi.advanceTimersByTimeAsync(5000)
    expect(notifyChanged).toHaveBeenCalledTimes(1)
  })

  it('keeps probing other repos when a dependency throws or rejects', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let fingerprint = 'a'
    const { reconcile, notifyChanged } = create({
      repos: () => [{ id: 'sync-throw' }, { id: 'rejects' }, { id: 'good' }],
      probe: (repo) => {
        if (repo.id === 'sync-throw') {
          throw new Error('boom')
        }
        return repo.id === 'rejects'
          ? Promise.reject(new Error('nope'))
          : Promise.resolve(fingerprint)
      }
    })

    reconcile.retain()
    await vi.advanceTimersByTimeAsync(1000)
    fingerprint = 'b'
    await vi.advanceTimersByTimeAsync(1000)
    expect(notifyChanged).toHaveBeenCalledExactlyOnceWith('good')
  })

  it('survives a throwing repo list and a throwing notifier', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let listThrows = true
    let fingerprint = 'a'
    const { reconcile, notifyChanged } = create({
      repos: () => {
        if (listThrows) {
          throw new Error('store unavailable')
        }
        return [{ id: 'one' }, { id: 'two' }]
      },
      probe: async () => fingerprint,
      notifyChanged: (repoId) => {
        if (repoId === 'one') {
          throw new Error('notify failed')
        }
      }
    })

    reconcile.retain()
    await vi.advanceTimersByTimeAsync(1000)
    listThrows = false
    await vi.advanceTimersByTimeAsync(1000)
    fingerprint = 'b'
    await vi.advanceTimersByTimeAsync(1000)
    expect(notifyChanged.mock.calls.map(([repoId]) => repoId)).toEqual(['one', 'two'])
  })

  it('does not reuse a baseline from before every client left', async () => {
    vi.useFakeTimers()
    let fingerprint = 'before-gap'
    const { reconcile, notifyChanged } = create({
      repos: () => [{ id: 'repo-1' }],
      probe: async () => fingerprint
    })

    reconcile.retain()()
    await vi.advanceTimersByTimeAsync(0)
    fingerprint = 'changed-during-gap'
    reconcile.retain()
    await vi.advanceTimersByTimeAsync(1000)
    expect(notifyChanged).not.toHaveBeenCalled()
  })

  it('discards a probe that began before the gap', async () => {
    vi.useFakeTimers()
    const resolvers: ((value: string) => void)[] = []
    let probes = 0
    const { reconcile, notifyChanged } = create({
      repos: () => [{ id: 'repo-1' }],
      probe: () => {
        probes++
        return probes === 1
          ? new Promise<string>((resolve) => resolvers.push(resolve))
          : Promise.resolve('after-gap')
      }
    })

    reconcile.retain()()
    reconcile.retain()
    // The stale probe finishes after re-retain and must not become the baseline.
    resolvers[0]('stale-before-gap')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(notifyChanged).not.toHaveBeenCalled()
  })

  it('keeps the baseline when a probe cannot tell', async () => {
    vi.useFakeTimers()
    const answers: (string | null)[] = ['two', null, 'one']
    const { reconcile, notifyChanged } = create({
      repos: () => [{ id: 'repo-1' }],
      probe: async () => answers.shift() ?? null
    })

    reconcile.retain()
    await vi.advanceTimersByTimeAsync(1000)
    expect(notifyChanged).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(notifyChanged).toHaveBeenCalledExactlyOnceWith('repo-1')
  })

  it('frees a wedged repo after the timeout and drops the late answer', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lateAnswers: ((value: string) => void)[] = []
    let calls = 0
    const probe = vi.fn((): Promise<string | null> => {
      calls++
      if (calls === 1) {
        return new Promise((resolve) => lateAnswers.push(resolve))
      }
      return Promise.resolve('one')
    })
    const { reconcile, notifyChanged } = create({
      repos: () => [{ id: 'repo-1' }],
      probe,
      probeTimeoutMs: 500
    })

    reconcile.retain()
    await vi.advanceTimersByTimeAsync(1000)
    expect(probe).toHaveBeenCalledTimes(2)

    lateAnswers[0]('stale-from-hung-mount')
    await vi.advanceTimersByTimeAsync(1000)
    expect(probe).toHaveBeenCalledTimes(3)
    expect(notifyChanged).not.toHaveBeenCalled()
  })
})
