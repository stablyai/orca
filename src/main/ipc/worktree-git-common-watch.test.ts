import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subscribeViaWatcherProcess } from './parcel-watcher-process'
import type {
  WatcherProcessCallback,
  WatcherProcessHooks
} from './parcel-watcher-process-subscription'
import type { WorktreeBaseWatchTarget } from './worktree-base-directory-event-filter'
import type {
  WorktreeBasePollEvent,
  WorktreePollerWindowVisibility
} from './worktree-base-directory-poller'
import { startGitCommonWatch } from './worktree-git-common-watch'

vi.mock('./parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: vi.fn()
}))

const POLL_MS = 25

const alwaysVisible: WorktreePollerWindowVisibility = {
  isWindowVisible: () => true,
  onWindowBecameVisible: () => () => {}
}

function createVisibilityHarness(): {
  source: WorktreePollerWindowVisibility
  hide: () => void
  show: () => void
} {
  let visible = true
  let listener: (() => void) | null = null
  return {
    source: {
      isWindowVisible: () => visible,
      onWindowBecameVisible: (nextListener) => {
        listener = nextListener
        return () => {
          if (listener === nextListener) {
            listener = null
          }
        }
      }
    },
    hide: () => {
      visible = false
    },
    show: () => {
      visible = true
      listener?.()
    }
  }
}

type ChildSubscription = {
  dir: string
  callback: WatcherProcessCallback
  hooks: WatcherProcessHooks
  unsubscribe: ReturnType<typeof vi.fn>
}

describe('worktree git-common narrow watch (darwin)', () => {
  const cleanups: (() => Promise<void>)[] = []
  const subscribeMock = vi.mocked(subscribeViaWatcherProcess)
  let childSubscriptions: ChildSubscription[] = []

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
    childSubscriptions = []
    subscribeMock.mockReset()
  })

  function installSubscribeMock(): void {
    subscribeMock.mockImplementation(async (dir, callback, _opts, hooks = {}) => {
      const unsubscribe = vi.fn(async () => {})
      childSubscriptions.push({ dir, callback, hooks, unsubscribe })
      return { unsubscribe }
    })
  }

  async function makeCommonDir(withWorktrees: boolean): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-git-common-watch-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const commonDir = await realpath(root)
    if (withWorktrees) {
      await mkdir(join(commonDir, 'worktrees'))
    }
    return commonDir
  }

  function makeTarget(path: string): WorktreeBaseWatchTarget {
    return {
      key: `git-common:local:${path}`,
      kind: 'git-common',
      path,
      repos: new Map([['repo-1', { repoId: 'repo-1', repoName: 'project', nestWorkspaces: false }]])
    }
  }

  async function startWatch(commonDir: string, received: WorktreeBasePollEvent[][]): Promise<void> {
    const watch = await startGitCommonWatch(
      makeTarget(commonDir),
      (events) => received.push(events),
      POLL_MS,
      'darwin',
      alwaysVisible
    )
    cleanups.push(() => watch.unsubscribe())
  }

  it('hosts the narrow stream in the watcher child, not in-process', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)

    expect(subscribeMock).toHaveBeenCalledTimes(1)
    const [dir, , opts] = subscribeMock.mock.calls[0]
    expect(dir).toBe(join(commonDir, 'worktrees'))
    expect(opts).toEqual({})

    const entryPath = join(commonDir, 'worktrees', 'wt-a')
    childSubscriptions[0].callback(null, [{ type: 'create', path: entryPath }])
    expect(received.flat()).toContainEqual({ type: 'create', path: entryPath })
  })

  it('tears down and re-arms when the watched root is deleted', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const worktreesDir = join(commonDir, 'worktrees')
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)

    await rm(worktreesDir, { recursive: true, force: true })
    childSubscriptions[0].callback(null, [{ type: 'delete', path: worktreesDir }])
    await vi.waitFor(() => {
      expect(childSubscriptions[0].unsubscribe).toHaveBeenCalledTimes(1)
    })
    expect(received.flat()).toContainEqual({ type: 'delete', path: worktreesDir })

    // The existence poll re-subscribes once a new first worktree recreates it.
    await mkdir(worktreesDir)
    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(2)
    })
    expect(received.flat()).toContainEqual({ type: 'create', path: worktreesDir })
  })

  it('tears down and re-arms on watcher errors', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const worktreesDir = join(commonDir, 'worktrees')
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)

    childSubscriptions[0].callback(new Error('watcher child reported failure'), [])
    await vi.waitFor(() => {
      expect(childSubscriptions[0].unsubscribe).toHaveBeenCalledTimes(1)
    })
    // The error is surfaced as a structural change so worktrees re-sync.
    expect(received.flat()).toContainEqual({ type: 'update', path: worktreesDir })

    // The dir still exists, so the existence poll re-subscribes.
    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(2)
    })

    const receivedAfterRearm = received.length
    childSubscriptions[0].callback(new Error('late error from replaced watcher'), [])
    childSubscriptions[0].callback(null, [
      { type: 'create', path: join(worktreesDir, 'late-old-event') }
    ])
    childSubscriptions[0].hooks.onInterruption?.()

    // A replaced watch cannot tear down its successor or report stale events.
    expect(received).toHaveLength(receivedAfterRearm)
    expect(childSubscriptions[1].unsubscribe).not.toHaveBeenCalled()
  })

  it('reports a structural change after a watcher-child interruption', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const worktreesDir = join(commonDir, 'worktrees')
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)

    childSubscriptions[0].hooks.onInterruption?.()
    expect(received.flat()).toContainEqual({ type: 'update', path: worktreesDir })
    // The supervisor resubscribed the same record; no teardown should happen.
    expect(childSubscriptions[0].unsubscribe).not.toHaveBeenCalled()
  })

  it('arms via existence polling when the worktrees dir appears later', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(false)
    const received: WorktreeBasePollEvent[][] = []
    await startWatch(commonDir, received)
    expect(subscribeMock).not.toHaveBeenCalled()

    await mkdir(join(commonDir, 'worktrees'))
    await vi.waitFor(() => {
      expect(subscribeMock).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps the native stream live while the primary poll is parked', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const headFile = join(commonDir, 'HEAD')
    await writeFile(headFile, 'ref: refs/heads/main')
    const visibility = createVisibilityHarness()
    const received: WorktreeBasePollEvent[][] = []
    const fullScans: number[] = []
    const watch = await startGitCommonWatch(
      makeTarget(commonDir),
      (events) => received.push(events),
      POLL_MS,
      'darwin',
      visibility.source,
      () => fullScans.push(Date.now())
    )
    cleanups.push(() => watch.unsubscribe())

    visibility.hide()
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2))
    await writeFile(headFile, 'ref: refs/heads/feature')
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2))

    expect(fullScans).toHaveLength(0)
    const entryPath = join(commonDir, 'worktrees', 'native-while-hidden')
    childSubscriptions[0].callback(null, [{ type: 'create', path: entryPath }])
    expect(received.flat()).toContainEqual({ type: 'create', path: entryPath })
    expect(childSubscriptions[0].unsubscribe).not.toHaveBeenCalled()

    visibility.show()
    expect(fullScans).toHaveLength(1)
    await vi.waitFor(() => {
      expect(received.flat()).toContainEqual({ type: 'update', path: headFile })
    })
  })

  it('stops forwarding events and unsubscribes the child on dispose', async () => {
    installSubscribeMock()
    const commonDir = await makeCommonDir(true)
    const received: WorktreeBasePollEvent[][] = []
    const watch = await startGitCommonWatch(
      makeTarget(commonDir),
      (events) => received.push(events),
      POLL_MS,
      'darwin',
      alwaysVisible
    )
    await watch.unsubscribe()
    expect(childSubscriptions[0].unsubscribe).toHaveBeenCalledTimes(1)

    received.length = 0
    childSubscriptions[0].callback(null, [
      { type: 'create', path: join(commonDir, 'worktrees', 'late') }
    ])
    expect(received).toHaveLength(0)
  })
})
