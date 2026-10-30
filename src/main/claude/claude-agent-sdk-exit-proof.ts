import type { SpawnedProcess } from '@orca/process-host/process-spec'
import {
  terminateDescendantSnapshotWithVerdict,
  type DescendantTreeVerdict
} from '../pty-descendant-exit-verification'
import { captureDescendantSnapshot, type DescendantSnapshot } from '../pty-descendant-termination'
import { terminateWindowsProcessTree } from '../windows-process-tree-kill'
import { mergeClaudeDescendantSnapshots } from './claude-child-tree-snapshot'
import { terminateClaudeRoot } from './claude-child-root-termination'
import { killProviderWriter } from '../provider-process/provider-process-teardown'
import {
  proveClaudeChildExitWithReaper,
  type ClaudeChildExitProofInput
} from './claude-child-exit-proof-ladder'

// Preserve observed exits and live descendants across later unreadable tables.
const TREE_VERDICT_TRUST: Record<DescendantTreeVerdict, number> = {
  unverifiable: 0,
  live: 1,
  exited: 2
}

type ReapableChild = Pick<SpawnedProcess, 'pid' | 'kill'>

// A missing or exited root may have reparented descendants; its walk cannot prove an empty tree.
function admissibleTree(
  captured: DescendantSnapshot | null,
  exited: boolean
): DescendantSnapshot | null {
  if (!captured || exited) {
    return null
  }
  return captured.rootPgid === null ? null : captured
}

export type ClaudeChildTreeReaperDeps = {
  platform?: NodeJS.Platform
  supervised?: boolean
  /** Whether the root's exit has been observed; only a live root can be walked. */
  exited?: () => boolean
  captureDescendants?: (rootPid: number) => Promise<DescendantSnapshot | null>
  terminateDescendants?: (snapshot: DescendantSnapshot) => Promise<DescendantTreeVerdict>
  /** `taskkill /T /F` on the held root; true only when taskkill reports the tree terminated. */
  terminateWindowsTree?: (rootPid: number) => Promise<boolean>
}

export type ClaudeChildTreeReaper = {
  /** Capture before root exit reparents descendants; failed reads remain retryable while it lives. */
  capture(): Promise<void>
  /** Refresh a live root's snapshot at the close boundary; a failed refresh keeps the prior proof. */
  refresh?: () => Promise<void>
  /** Concurrent calls share one reap; later calls reverify the retained snapshot. */
  reap(): Promise<DescendantTreeVerdict>
  /** Latched evidence: POSIX observations or Windows taskkill reports; unreadable tables cannot erase it. */
  readonly treeVerdict: DescendantTreeVerdict
  /** Once a reap reaches the live root, its later exit cannot count as voluntary. */
  readonly forcedReapAttempted: boolean
  readonly killDelivered?: boolean
}

// Pipe children have no PTY job to sweep; only explicit tree verification can prove their exit.
export function createClaudeChildTreeReaper(
  child: ReapableChild,
  deps: ClaudeChildTreeReaperDeps = {}
): ClaudeChildTreeReaper {
  const platform = deps.platform ?? process.platform
  const exited = deps.exited ?? (() => false)
  // Windows reaches the tree through the held root instead, so it never snapshots.
  const snapshots = platform !== 'win32'
  const capture = deps.captureDescendants ?? captureDescendantSnapshot
  // undefined permits capture retries; null invalidates the snapshot after root exit or identity loss.
  let snapshot: DescendantSnapshot | null | undefined
  let capturing: Promise<void> | null = null
  let refreshing: Promise<void> | null = null
  let queuedRefresh: Promise<void> | null = null
  let inFlight: Promise<DescendantTreeVerdict> | null = null
  let treeVerdict: DescendantTreeVerdict = 'unverifiable'
  let forcedReapAttempted = false
  let killDelivered = false

  function captureOnce(): Promise<void> {
    if (!snapshots) {
      return Promise.resolve()
    }
    if (refreshing) {
      const pending = refreshing
      return pending.then(() => queuedRefresh ?? undefined)
    }
    if (snapshot !== undefined) {
      return Promise.resolve()
    }
    if (capturing) {
      const pending = capturing
      return pending.then(() => queuedRefresh ?? undefined)
    }
    const rootPid = child.pid
    if (!rootPid || exited()) {
      // Root exit reparents descendants, making a missing snapshot final.
      snapshot = exited() ? null : snapshot
      return Promise.resolve()
    }
    capturing = capture(rootPid)
      .catch(() => null)
      .then((captured) => {
        const rootExited = exited()
        const tree = admissibleTree(captured, rootExited)
        if (tree) {
          snapshot = tree
        } else if (rootExited) {
          snapshot = null
        } else {
          // Retry failed reads while the root lives; missing evidence cannot prove an empty tree.
          snapshot = undefined
        }
      })
      .finally(() => {
        capturing = null
      })
    return capturing
  }

  function startRefresh(): Promise<void> {
    if (exited()) {
      return Promise.resolve()
    }
    const rootPid = child.pid
    if (!rootPid) {
      return Promise.resolve()
    }
    const operation = (async () => {
      const captured = await capture(rootPid).catch(() => null)
      if (exited()) {
        return
      }
      const tree = admissibleTree(captured, false)
      if (!tree) {
        return
      }
      if (snapshot === undefined) {
        snapshot = tree
        return
      }
      if (snapshot !== null) {
        // Identity loss invalidates descendant evidence; Node still owns the root handle.
        snapshot = mergeClaudeDescendantSnapshots(snapshot, tree)
      }
    })()
    refreshing = operation
    const clearRefreshing = (): void => {
      if (refreshing === operation) {
        refreshing = null
      }
    }
    void operation.then(clearRefreshing, clearRefreshing)
    return operation
  }

  function queueRefreshAfter(pending: Promise<void>): Promise<void> {
    if (queuedRefresh) {
      return queuedRefresh
    }
    const operation = pending.then(() => {
      if (exited()) {
        return
      }
      return startRefresh()
    })
    queuedRefresh = operation
    const clearQueuedRefresh = (): void => {
      if (queuedRefresh === operation) {
        queuedRefresh = null
      }
    }
    void operation.then(clearQueuedRefresh, clearQueuedRefresh)
    return operation
  }

  async function refresh(): Promise<void> {
    if (!snapshots) {
      return
    }
    const pending = capturing ?? refreshing
    if (pending) {
      await queueRefreshAfter(pending)
      return
    }
    if (queuedRefresh) {
      await queuedRefresh
      return
    }
    try {
      await startRefresh()
    } catch {
      // A refresh is advisory; capture failures leave the prior proof intact.
    }
  }

  async function judgeWindowsTree(rootPid: number): Promise<DescendantTreeVerdict> {
    if (exited()) {
      // The root's pid left with it, so its tree can no longer be addressed.
      return 'unverifiable'
    }
    const terminateTree =
      deps.terminateWindowsTree ??
      ((pid: number) => terminateWindowsProcessTree(pid, { site: 'claude-structured-child-close' }))
    const terminated = await terminateTree(rootPid).catch(() => false)
    killDelivered ||= terminated
    try {
      terminateClaudeRoot({ child, exited })
    } catch {
      // Exact-root cleanup cannot retract successful tree termination.
    }
    // Only taskkill's clean exit reports the whole tree terminated.
    return terminated ? 'exited' : 'unverifiable'
  }

  async function judgeTree(): Promise<DescendantTreeVerdict> {
    let writerSnapshot: DescendantSnapshot | null = null
    const killRoot = (): void => {
      if (!exited()) {
        killDelivered = killProviderWriter(child, writerSnapshot, deps) || killDelivered
        if (deps.supervised) {
          terminateClaudeRoot({ child, exited })
        }
      }
    }
    const rootPid = child.pid
    if (!rootPid) {
      return 'exited'
    }
    if (!exited()) {
      forcedReapAttempted = true
    }
    if (!snapshots) {
      return judgeWindowsTree(rootPid)
    }
    await captureOnce()
    if (deps.supervised && !exited()) {
      child.kill('SIGSTOP')
      writerSnapshot = await capture(rootPid).catch(() => null)
    }
    if (!snapshot) {
      killRoot()
      return 'unverifiable'
    }
    if (snapshot.descendants.length === 0) {
      // The live-root snapshot had no descendants to reverify.
      killRoot()
      return 'exited'
    }
    // Stopping the root leaves killed children as zombies on macOS; kill it so init can reap them.
    if (deps.supervised) {
      killDelivered = killProviderWriter(child, writerSnapshot, deps) || killDelivered
    }
    const verdictPromise = deps.terminateDescendants
      ? deps.terminateDescendants(snapshot)
      : terminateDescendantSnapshotWithVerdict(snapshot, {
          requireIdentityBeforeSignal: true
        })
    killRoot()
    return verdictPromise
  }

  return {
    capture: captureOnce,
    refresh,
    reap() {
      if (inFlight) {
        return inFlight
      }
      const attempt = judgeTree()
        .catch((): DescendantTreeVerdict => 'unverifiable')
        .then((verdict) => {
          treeVerdict =
            TREE_VERDICT_TRUST[verdict] > TREE_VERDICT_TRUST[treeVerdict] ? verdict : treeVerdict
          return verdict
        })
      inFlight = attempt
      void attempt.finally(() => {
        if (inFlight === attempt) {
          inFlight = null
        }
      })
      return attempt
    },
    get treeVerdict() {
      return treeVerdict
    },
    get killDelivered() {
      return killDelivered
    },
    get forcedReapAttempted() {
      return forcedReapAttempted
    }
  }
}

/** Prove root exit plus descendant exit; Windows also accepts voluntary exit before any forced reap. */
export function proveClaudeChildExit(input: ClaudeChildExitProofInput): Promise<boolean> {
  return proveClaudeChildExitWithReaper(input, () =>
    createClaudeChildTreeReaper(input.managed.child, {
      exited: () => input.managed.rootVerdict === 'exited'
    })
  )
}
