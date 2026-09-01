import type { BrowserWindow } from 'electron'
import { notifyWorktreeHeadIdentitiesChanged } from './worktree-remote'
import {
  createWorktreeHeadIdentityCache,
  readGitCommonHeadIdentities,
  type WorktreeHeadIdentityCache
} from './worktree-head-identity-reader'
import {
  EMPTY_HEAD_IDENTITY_SCOPE,
  FULL_HEAD_IDENTITY_SCOPE,
  isEmptyHeadIdentityScope,
  mergeHeadIdentityScopes,
  type WorktreeHeadIdentityScope
} from './worktree-head-identity-scope'

type HeadIdentityWatchHost = {
  path: string
  repos: ReadonlyMap<string, unknown>
  mainWindow: BrowserWindow
  disposed: boolean
}

export type WorktreeHeadIdentityRefreshState = {
  /** worktreePath → `${head} ${branch}` from the last metadata-file read. */
  baseline: Map<string, string> | null
  cache: WorktreeHeadIdentityCache
  lastFullReadAtMs: number
  inFlight: boolean
  queuedScope: WorktreeHeadIdentityScope | null
  queuedEmit: boolean
}

// Why: a ref can move with no event under any admin dir — `git update-ref
// refs/heads/x` from a sibling worktree appends no HEAD reflog for the worktree
// that has `x` checked out (verified on git 2.44). Scoped refreshes cannot see
// that, so promote back to a full re-read on the first refresh that runs once
// this interval has elapsed. This is opportunistic, not a timer: it caps the
// cost of staying correct at one full read per interval of watcher activity,
// but a fully idle repo still refreshes nothing at all (as it did before).
export const HEAD_IDENTITY_FULL_REBASELINE_INTERVAL_MS = 60_000

export function createWorktreeHeadIdentityRefreshState(): WorktreeHeadIdentityRefreshState {
  return {
    baseline: null,
    cache: createWorktreeHeadIdentityCache(),
    lastFullReadAtMs: 0,
    inFlight: false,
    queuedScope: null,
    queuedEmit: false
  }
}

function headIdentitySignature(identity: { head: string; branch: string | null }): string {
  return `${identity.head} ${identity.branch ?? ''}`
}

function resolveScope(
  state: WorktreeHeadIdentityRefreshState,
  scope: WorktreeHeadIdentityScope
): WorktreeHeadIdentityScope {
  if (scope.all || state.baseline === null) {
    return FULL_HEAD_IDENTITY_SCOPE
  }
  return Date.now() - state.lastFullReadAtMs >= HEAD_IDENTITY_FULL_REBASELINE_INTERVAL_MS
    ? FULL_HEAD_IDENTITY_SCOPE
    : scope
}

/** Diffs metadata-file head reads against the previous baseline and notifies
 *  only actual head moves, so status-only churn (index rewrites from external
 *  `git status`) stays silent and never re-enters structural fanout. Passing
 *  `emit: false` re-baselines without notifying — structural ticks already
 *  run the authoritative worktree listing.
 *
 *  `scope` narrows the read to the worktrees a watcher burst could have moved;
 *  omitting it (watcher errors, event overflow, cold start) re-reads everything. */
export async function refreshWorktreeHeadIdentities(
  host: HeadIdentityWatchHost,
  state: WorktreeHeadIdentityRefreshState,
  emit: boolean,
  scope: WorktreeHeadIdentityScope = FULL_HEAD_IDENTITY_SCOPE
): Promise<void> {
  if (host.disposed || host.mainWindow.isDestroyed()) {
    return
  }
  if (state.inFlight) {
    state.queuedScope = mergeHeadIdentityScopes(
      state.queuedScope ?? EMPTY_HEAD_IDENTITY_SCOPE,
      scope
    )
    state.queuedEmit ||= emit
    return
  }
  // Why: the queued re-run below can be handed to a window that was destroyed
  // mid-read (macOS recreates it while the watch lives on), and that call
  // returns at the guard above. Fold anything still queued into this request so
  // a stranded scope is never dropped on the floor.
  const requestedScope = state.queuedScope
    ? mergeHeadIdentityScopes(state.queuedScope, scope)
    : scope
  const requestedEmit = emit || state.queuedEmit
  state.queuedScope = null
  state.queuedEmit = false
  // Resolve BEFORE the skip: an empty scope is still an opportunity to take the
  // periodic re-baseline, and a repo whose only churn is `git worktree
  // lock`/`unlock` or a sparse toggle must not be able to starve it forever.
  const effectiveScope = resolveScope(state, requestedScope)
  // Nothing the burst touched can move a head (a `locked` or `config.worktree`
  // write) and no re-baseline is due: read nothing.
  //
  // Load-bearing invariant behind the promotion above: an empty scope only ever
  // reaches here from `structuralChange(repoIds, EMPTY)`, which populates
  // `pendingStructure` for EVERY repo on this watch (`allRepoIds`), which forces
  // `emit: false`. So a promoted re-baseline triggered by an empty-scope burst
  // corrects the baseline silently and publishes nothing — safe precisely
  // because the same flush already sent that watch's repos a catalog
  // notification, and the renderer's authoritative listing carries the head.
  if (state.baseline !== null && isEmptyHeadIdentityScope(effectiveScope)) {
    return
  }
  state.inFlight = true
  try {
    const { identities, listingComplete } = await readGitCommonHeadIdentities(
      host.path,
      state.cache,
      effectiveScope
    )
    if (host.disposed || host.mainWindow.isDestroyed()) {
      return
    }
    // After the teardown check, so a read whose result is discarded cannot pass
    // for a checkpoint. A read that could not enumerate `worktrees/` has not
    // seen entries added since the last good listing, so it is not one either.
    if (effectiveScope.all && listingComplete) {
      state.lastFullReadAtMs = Date.now()
    }
    const baseline = state.baseline
    // Rows this pass could not observe are carried forward: dropping them would
    // make the next successful listing report every linked worktree as changed.
    const nextBaseline = listingComplete ? new Map<string, string>() : new Map(baseline ?? [])
    for (const identity of identities) {
      nextBaseline.set(identity.worktreePath, headIdentitySignature(identity))
    }
    // Why `emit: false` is safe to publish nothing: the only classification that
    // reaches here with a head-moving scope and no emit is a structural burst,
    // and structural bursts notify the worktree catalog for every repo on this
    // watch — the renderer's authoritative listing carries the head. So a silent
    // pass is always paired with a stronger refresh, never a dropped update.
    const changed =
      baseline && requestedEmit
        ? identities.filter(
            (identity) => baseline.get(identity.worktreePath) !== headIdentitySignature(identity)
          )
        : []
    for (const repoId of changed.length > 0 ? host.repos.keys() : []) {
      notifyWorktreeHeadIdentitiesChanged(host.mainWindow, repoId, changed)
    }
    // Last, so a send that throws part-way leaves the old baseline and the next
    // refresh re-diffs instead of silently dropping the move.
    state.baseline = nextBaseline
  } catch (error) {
    console.warn(`[worktree-base-watcher] head identity read failed for ${host.path}:`, error)
    // A failed read leaves the cache in an unknown state; force the next
    // refresh to re-read every entry rather than trust a partial memo.
    state.cache = createWorktreeHeadIdentityCache()
    state.lastFullReadAtMs = 0
  } finally {
    state.inFlight = false
    if (state.queuedScope && !host.disposed) {
      // Leave the queue armed: if this call cannot proceed (destroyed window),
      // the next refresh folds it back in at the entry above.
      void refreshWorktreeHeadIdentities(host, state, state.queuedEmit, state.queuedScope)
    }
  }
}
