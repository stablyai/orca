import type { SpawnedProcess } from '../../shared/child-process/run-process'
import {
  terminateDescendantSnapshotWithVerdict,
  type DescendantTreeVerdict
} from '../pty-descendant-exit-verification'
import {
  captureDescendantSnapshot,
  type DescendantSnapshot,
  type PosixProcessIdentity
} from '../pty-descendant-termination'
import {
  captureWindowsDescendantSnapshot,
  terminateIdentifiedWindowsProcessTree,
  verifyWindowsDescendantSnapshotExit,
  verifyWindowsProcessIdentity,
  type WindowsDescendantSnapshot,
  type WindowsProcessIdentity
} from '../windows-descendant-exit-verification'
import { mergeClaudeCapturedTrees, type ClaudeCapturedTree } from './claude-child-tree-snapshot'
import { terminateClaudeRoot, terminateClaudeWindowsRoot } from './claude-child-root-termination'
import {
  proveClaudeChildExitWithReaper,
  type ClaudeChildExitProofInput
} from './claude-child-exit-proof-ladder'

/**
 * A later reap may only raise the latched verdict. An observed exit is final, and
 * a descendant seen alive at a deadline is never forgotten by a later look that
 * could not read the table: the lease gate discriminates on exactly that pair.
 */
const TREE_VERDICT_TRUST: Record<DescendantTreeVerdict, number> = {
  unverifiable: 0,
  live: 1,
  exited: 2
}

type ReapableChild = Pick<SpawnedProcess, 'pid' | 'kill'>

/**
 * A walk is only admissible while the root it walked was alive. A POSIX walk
 * that found no root says so with a null pgid; either platform's walk can also
 * have raced the root's death. Both can only have missed descendants that
 * already reparented away, so neither is evidence about the tree.
 */
function admissibleTree(
  captured: DescendantSnapshot | WindowsDescendantSnapshot | null,
  platform: NodeJS.Platform,
  exited: boolean
): ClaudeCapturedTree | null {
  if (!captured || exited) {
    return null
  }
  if (platform === 'win32') {
    return { platform: 'win32', tree: captured as WindowsDescendantSnapshot }
  }
  const tree = captured as DescendantSnapshot
  return tree.rootPgid === null ? null : { platform: 'posix', tree }
}

export type ClaudeChildTreeReaperDeps = {
  platform?: NodeJS.Platform
  /** Whether the root's exit has been observed; only a live root can be walked. */
  exited?: () => boolean
  captureDescendants?: (rootPid: number) => Promise<DescendantSnapshot | null>
  terminateDescendants?: (snapshot: DescendantSnapshot) => Promise<DescendantTreeVerdict>
  terminateWindowsTree?: (root: WindowsProcessIdentity) => Promise<void>
  captureWindowsDescendants?: (rootPid: number) => Promise<WindowsDescendantSnapshot | null>
  terminateWindowsDescendants?: (
    snapshot: WindowsDescendantSnapshot
  ) => Promise<DescendantTreeVerdict>
  /** Identity probe for the bare-pid tree kill; only Windows has one to gate. */
  verifyRootIdentity?: (root: PosixProcessIdentity | WindowsProcessIdentity) => Promise<boolean>
}

export type ClaudeChildTreeReaper = {
  /**
   * Snapshot the root's live descendants. The moment the root dies they reparent
   * and no table walk can find them again, so this has to run before anything
   * gives the root a reason to leave. Held once; later calls are no-ops.
   */
  capture(): Promise<void>
  /** Refresh a live root's snapshot at the close boundary; a failed refresh keeps the prior proof. */
  refresh?: () => Promise<void>
  /**
   * Kill the child's whole tree and report what the bounded verification
   * observed. Concurrent calls share one reap, and a later call re-verifies the
   * same snapshot rather than trusting a root that has since died on its own.
   */
  reap(): Promise<DescendantTreeVerdict>
  /**
   * `unverifiable` until a reap observes otherwise. `exited` is the only verdict
   * that lets a close release the lease; `live` names a descendant that was seen
   * still running, which no later caller may collapse into "unknown".
   */
  readonly treeVerdict: DescendantTreeVerdict
}

/**
 * The same shared primitives the Codex structured provider composes: a raw
 * pipe child owns no PTY job, so there is nothing for the PTY job sweep to
 * terminate on Windows and no unref'd timer is allowed to outlive the proof.
 *
 * The proof is unproven by default. `treeVerdict` is assigned in exactly one
 * place, from the verdict of `judgeTree`, so a code path that never reaches a
 * verification cannot report the tree gone by omission.
 */
export function createClaudeChildTreeReaper(
  child: ReapableChild,
  deps: ClaudeChildTreeReaperDeps = {}
): ClaudeChildTreeReaper {
  const platform = deps.platform ?? process.platform
  const exited = deps.exited ?? (() => false)
  // Undefined until captured; null when no admissible snapshot exists — the root
  // was already gone, or the table could not be read while it was alive — which
  // no later read can make up for.
  let snapshot: ClaudeCapturedTree | null | undefined
  let capturing: Promise<void> | null = null
  let refreshing: Promise<void> | null = null
  let queuedRefresh: Promise<void> | null = null
  let inFlight: Promise<DescendantTreeVerdict> | null = null
  let treeVerdict: DescendantTreeVerdict = 'unverifiable'

  // Consulted only on win32: POSIX signals descendants by revalidated identity
  // and reaches the root solely through Node's handle, so neither needs a probe.
  const verifyRoot =
    deps.verifyRootIdentity ??
    ((root: PosixProcessIdentity | WindowsProcessIdentity) =>
      verifyWindowsProcessIdentity(root as WindowsProcessIdentity))

  function captureOnce(): Promise<void> {
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
      // Only the root's death makes a missing snapshot final: its descendants
      // have reparented, and no later walk can reach them.
      snapshot = exited() ? null : snapshot
      return Promise.resolve()
    }
    const capture =
      platform === 'win32'
        ? (deps.captureWindowsDescendants ?? captureWindowsDescendantSnapshot)
        : (deps.captureDescendants ?? captureDescendantSnapshot)
    capturing = capture(rootPid)
      .catch(() => null)
      .then((captured) => {
        // A walk that found no root, or that raced the root's death, can only
        // have missed descendants that already reparented away. A table that
        // could not be read in time is not an answer at all: while the root
        // still lives the walk is simply retried, rather than latching a failed
        // read as proof that there was nothing to find.
        const rootExited = exited()
        const tree = admissibleTree(captured, platform, rootExited)
        if (tree) {
          snapshot = tree
        } else if (rootExited) {
          // Once the root has exited its descendants may have reparented; no
          // later table read can make an absent snapshot safe to signal.
          snapshot = null
        } else {
          // A failed read or a walk that did not observe the live root is
          // retryable while the root remains alive. Never latch a vacuous null.
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
    const capture =
      platform === 'win32'
        ? (deps.captureWindowsDescendants ?? captureWindowsDescendantSnapshot)
        : (deps.captureDescendants ?? captureDescendantSnapshot)
    const operation = (async () => {
      const captured = await capture(rootPid).catch(() => null)
      if (exited()) {
        return
      }
      const tree = admissibleTree(captured, platform, false)
      if (!tree) {
        return
      }
      if (snapshot === undefined) {
        snapshot = tree
        return
      }
      if (snapshot !== null) {
        // A merge that returns null saw a same-PID identity change: a
        // recycle/replace decision, not an absent descendant, so no row here may
        // be signalled from its number. Only the descendant evidence is lost —
        // the root still leaves through the handle no recycled pid can reach.
        snapshot = mergeClaudeCapturedTrees(snapshot, tree)
      }
      // Keep an earlier admissible snapshot when this close-boundary read fails;
      // it remains the only identity-safe evidence after root exit.
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

  /** The only source of a tree verdict: every `exited` here is an observation. */
  async function judgeTree(): Promise<DescendantTreeVerdict> {
    const killRoot = (): boolean => terminateClaudeRoot({ child, exited })
    const rootPid = child.pid
    if (!rootPid) {
      // Never spawned, so the OS never created a tree to orphan.
      return 'exited'
    }
    await captureOnce()
    if (platform === 'win32') {
      // Why taskkill's own outcome is never the verdict: it resolves identically
      // on a timeout, an access denial, a recycled root and a real kill.
      const { rootVerified } = await terminateClaudeWindowsRoot({
        snapshot: snapshot?.platform === 'win32' ? snapshot.tree : null,
        exited,
        verifyRoot: (root) => verifyRoot(root),
        terminateTree: (root) =>
          deps.terminateWindowsTree
            ? deps.terminateWindowsTree(root)
            : terminateIdentifiedWindowsProcessTree(root, {
                ownsRoot: () => !exited()
              }).then(() => undefined),
        killRoot
      })
      if (!rootVerified && !exited()) {
        return 'unverifiable'
      }
      return snapshot?.platform === 'win32'
        ? await (deps.terminateWindowsDescendants ?? verifyWindowsDescendantSnapshotExit)(
            snapshot.tree
          )
        : 'unverifiable'
    }
    if (snapshot?.platform !== 'posix') {
      killRoot()
      return 'unverifiable'
    }
    if (snapshot.tree.descendants.length === 0) {
      // Read while the root was alive and childless: a later table read has no
      // row it could match, so it would add nothing to this observation.
      killRoot()
      return 'exited'
    }
    // Why the root is killed while verification is already running, and never
    // SIGSTOPped first the way the Codex non-group path does: measured on macOS, a
    // killed child of a stopped parent stays a zombie row in ps with its lstart
    // and pgid intact, so verification cannot pass until the root is dead. The
    // descendants are signalled by the verifier as soon as it revalidates their
    // identities; the root's death then reparents any zombies to init, which
    // reaps them. After a root exit the kill is a no-op: Node drops the handle
    // on exit and never signals a possibly recycled pid.
    const verdictPromise = deps.terminateDescendants
      ? deps.terminateDescendants(snapshot.tree)
      : terminateDescendantSnapshotWithVerdict(snapshot.tree, {
          requireIdentityBeforeSignal: true
        })
    killRoot()
    // What the verification observed is the verdict: a kill that reports no
    // signal means the handle was already gone, never that the tree survived.
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
    }
  }
}

/**
 * Orca's own shutdown ladder on the child it spawned, kept because the SDK's
 * close path returns no proof and Orca never releases a lease on an assumed exit.
 *
 * Resolves true only after the child actually emitted exit and its snapshotted
 * descendants were observed gone; false is unproven. A root that left on its
 * own before a snapshot could be armed stays unproven: its descendants had
 * already reparented out of reach when the ladder first looked.
 */
export function proveClaudeChildExit(input: ClaudeChildExitProofInput): Promise<boolean> {
  return proveClaudeChildExitWithReaper(input, () =>
    createClaudeChildTreeReaper(input.child, { exited: input.exited })
  )
}
