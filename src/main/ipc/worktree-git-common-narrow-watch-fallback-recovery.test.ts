import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subscribeViaWatcherProcess } from './parcel-watcher-process'
import { WatcherProcessFailure } from './parcel-watcher-process-failure'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks
} from './parcel-watcher-process-subscription'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import type {
  WorktreeBasePollEvent,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import { startGitCommonNarrowWatch } from './worktree-git-common-narrow-watch'

vi.mock('./parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: vi.fn()
}))

const POLL_MS = 25
const alwaysVisible: WorktreePollerWindowVisibility = {
  isWindowVisible: () => true,
  onWindowBecameVisible: () => () => {}
}

type ChildSubscription = {
  callback: WatcherProcessCallback
  hooks: WatcherProcessHooks
  unsubscribe: ReturnType<typeof vi.fn<() => Promise<void>>>
}

describe('git-common narrow watch, recovering from the crash-fuse polling fallback', () => {
  const cleanups: (() => Promise<void>)[] = []
  const subscribeMock = vi.mocked(subscribeViaWatcherProcess)
  let subscriptions: ChildSubscription[] = []

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
    subscriptions = []
    subscribeMock.mockReset()
    vi.useRealTimers()
  })

  function installSubscribeMock(): void {
    subscribeMock.mockImplementation(async (_dir, callback, _opts, hooks = {}) => {
      const unsubscribe = vi.fn(async () => {})
      subscriptions.push({ callback, hooks, unsubscribe })
      return { unsubscribe }
    })
  }

  // Why: each retry attempt's real fs I/O (the stat in trySubscribe, the
  // fallback poller's snapshot) is not advanced by the fake clock -- a bulk
  // advanceTimersByTimeAsync loop can exhaust its bound before that I/O
  // settles under load, so give it real wall-clock time on top rather than
  // asserting the instant the loop stops.
  async function waitForSubscribeCalls(count: number): Promise<void> {
    await vi.waitFor(() => expect(subscribeMock).toHaveBeenCalledTimes(count), {
      timeout: 5_000,
      interval: 25
    })
  }

  async function makeCommonDir(): Promise<{ commonDir: string; worktreesDir: string }> {
    const root = await mkdtemp(join(tmpdir(), 'orca-git-common-fallback-retry-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const commonDir = await realpath(root)
    const worktreesDir = join(commonDir, 'worktrees')
    await mkdir(worktreesDir)
    return { commonDir, worktreesDir }
  }

  function makeTarget(path: string): WorktreeBaseWatchTarget {
    return {
      key: `git-common:local:${path}`,
      kind: 'git-common',
      path,
      repos: new Map([['repo-1', { repoId: 'repo-1', repoName: 'project', nestWorkspaces: false }]])
    }
  }

  it('upgrades back to the native watch once a backoff retry succeeds', async () => {
    vi.useFakeTimers()
    installSubscribeMock()
    const { commonDir, worktreesDir } = await makeCommonDir()
    const received: WorktreeBasePollEvent[][] = []
    const watch = await startGitCommonNarrowWatch(
      makeTarget(commonDir),
      (events) => received.push(events),
      POLL_MS,
      'darwin',
      alwaysVisible
    )
    cleanups.push(() => watch.unsubscribe())

    expect(subscribeMock).toHaveBeenCalledTimes(1)
    const original = subscriptions[0]
    original.callback(
      new WatcherProcessFailure(
        'watcher process crashed repeatedly',
        'supervisor',
        'supervisor_crash_fuse'
      ),
      []
    )
    await vi.waitFor(() => {
      expect(original.unsubscribe).toHaveBeenCalledOnce()
    })
    // The fallback is a structural poller, not another native subscribe call.
    expect(subscribeMock).toHaveBeenCalledTimes(1)

    // Advance in small steps -- entering the fallback involves genuine fs
    // I/O (reconciliation teardown, the fallback poller's first snapshot)
    // that a single large fake-timer jump can outrun, leaving the retry timer
    // unarmed when the jump ends. Fine-grained steps interleave reliably.
    for (
      let elapsed = 0;
      elapsed < 5 * 60_000 && subscribeMock.mock.calls.length < 2;
      elapsed += 1_000
    ) {
      await vi.advanceTimersByTimeAsync(1_000)
    }
    await waitForSubscribeCalls(2)

    const recovered = subscriptions[1]
    expect(recovered).toBeDefined()
    expect(recovered).not.toBe(original)

    const entryPath = join(worktreesDir, 'wt-recovered')
    // Firing the callback synchronously (no poll tick delay) is only possible
    // once the native stream, not the fallback poller, is the active path.
    recovered.callback(null, [{ type: 'create', path: entryPath }])
    expect(received.flat()).toContainEqual({ type: 'create', path: entryPath })
  })

  it('keeps retrying on a fixed backoff while the process stays unavailable', async () => {
    vi.useFakeTimers()
    subscribeMock.mockRejectedValueOnce(
      new WatcherProcessFailure('watcher process unavailable', 'supervisor', 'process_unavailable')
    )
    const { commonDir } = await makeCommonDir()
    const watch = await startGitCommonNarrowWatch(
      makeTarget(commonDir),
      () => {},
      POLL_MS,
      'darwin',
      alwaysVisible
    )
    cleanups.push(() => watch.unsubscribe())

    // Initial subscribe attempt failed straight into the fallback.
    expect(subscribeMock).toHaveBeenCalledTimes(1)

    subscribeMock.mockRejectedValueOnce(
      new WatcherProcessFailure('watcher process unavailable', 'supervisor', 'process_unavailable')
    )
    for (
      let elapsed = 0;
      elapsed < 5 * 60_000 && subscribeMock.mock.calls.length < 2;
      elapsed += 1_000
    ) {
      await vi.advanceTimersByTimeAsync(1_000)
    }
    // First retry attempt fired and failed the same way -- still fallback.
    await waitForSubscribeCalls(2)

    installSubscribeMock()
    for (
      let elapsed = 0;
      elapsed < 10 * 60_000 && subscribeMock.mock.calls.length < 3;
      elapsed += 1_000
    ) {
      await vi.advanceTimersByTimeAsync(1_000)
    }
    // Second retry, on the doubled backoff, finally succeeds.
    await waitForSubscribeCalls(3)
  })

  it('resets the backoff after a recovery, so a later fallback episode restarts at the base delay', async () => {
    vi.useFakeTimers()
    installSubscribeMock()
    const { commonDir } = await makeCommonDir()
    const watch = await startGitCommonNarrowWatch(
      makeTarget(commonDir),
      () => {},
      POLL_MS,
      'darwin',
      alwaysVisible
    )
    cleanups.push(() => watch.unsubscribe())
    expect(subscribeMock).toHaveBeenCalledTimes(1)

    // First fallback episode: recovers on the very first (30s) retry.
    subscriptions[0].callback(
      new WatcherProcessFailure(
        'watcher process crashed repeatedly',
        'supervisor',
        'supervisor_crash_fuse'
      ),
      []
    )
    for (
      let elapsed = 0;
      elapsed < 5 * 60_000 && subscribeMock.mock.calls.length < 2;
      elapsed += 1_000
    ) {
      await vi.advanceTimersByTimeAsync(1_000)
    }
    await waitForSubscribeCalls(2)

    // Second, unrelated fallback episode, off the now-recovered subscription.
    subscriptions[1].callback(
      new WatcherProcessFailure(
        'watcher process crashed repeatedly',
        'supervisor',
        'supervisor_crash_fuse'
      ),
      []
    )
    // A reset backoff retries at ~30s; an un-reset one would wait ~60s here.
    for (
      let elapsed = 0;
      elapsed < 50_000 && subscribeMock.mock.calls.length < 3;
      elapsed += 1_000
    ) {
      await vi.advanceTimersByTimeAsync(1_000)
    }
    await waitForSubscribeCalls(3)
  })
})
