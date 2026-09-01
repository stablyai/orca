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
// that, so promote one refresh per interval back to a full re-read. This bounds
// the blind window instead of relying on unrelated fleet churn to trip a scan.
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
  // Resolve BEFORE the skip: an empty scope is still an opportunity to take the
  // periodic re-baseline, and a repo whose only churn is `git worktree
  // lock`/`unlock` or a sparse toggle must not be able to starve it forever.
  const effectiveScope = resolveScope(state, scope)
  // Nothing the burst touched can move a head (a `locked` or `config.worktree`
  // write) and no re-baseline is due: read nothing.
  if (state.baseline !== null && isEmptyHeadIdentityScope(effectiveScope)) {
    return
  }
  state.inFlight = true
  try {
    const identities = await readGitCommonHeadIdentities(host.path, state.cache, effectiveScope)
    if (effectiveScope.all) {
      state.lastFullReadAtMs = Date.now()
    }
    if (host.disposed || host.mainWindow.isDestroyed()) {
      return
    }
    const baseline = state.baseline
    state.baseline = new Map(
      identities.map((identity) => [identity.worktreePath, headIdentitySignature(identity)])
    )
    if (!baseline || !emit) {
      return
    }
    const changed = identities.filter(
      (identity) => baseline.get(identity.worktreePath) !== headIdentitySignature(identity)
    )
    if (changed.length === 0) {
      return
    }
    for (const repoId of host.repos.keys()) {
      notifyWorktreeHeadIdentitiesChanged(host.mainWindow, repoId, changed)
    }
  } catch (error) {
    console.warn(`[worktree-base-watcher] head identity read failed for ${host.path}:`, error)
    // A failed read leaves the cache in an unknown state; force the next
    // refresh to re-read every entry rather than trust a partial memo.
    state.cache = createWorktreeHeadIdentityCache()
    state.lastFullReadAtMs = 0
  } finally {
    state.inFlight = false
    if (state.queuedScope && !host.disposed) {
      const queuedScope = state.queuedScope
      const queuedEmit = state.queuedEmit
      state.queuedScope = null
      state.queuedEmit = false
      void refreshWorktreeHeadIdentities(host, state, queuedEmit, queuedScope)
    }
  }
}
