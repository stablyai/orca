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
  /** One-shot catch-up armed only by a scoped pass; see `scheduleRebaseline`. */
  rebaselineTimer: ReturnType<typeof setTimeout> | null
}

// External update-ref can bypass scoped watcher events; full rereads bound missed heads and scoping mistakes.
export const HEAD_IDENTITY_FULL_REBASELINE_INTERVAL_MS = 60_000

export function createWorktreeHeadIdentityRefreshState(): WorktreeHeadIdentityRefreshState {
  return {
    baseline: null,
    cache: createWorktreeHeadIdentityCache(),
    lastFullReadAtMs: 0,
    inFlight: false,
    queuedScope: null,
    queuedEmit: false,
    rebaselineTimer: null
  }
}

export function disposeWorktreeHeadIdentityRefreshState(
  state: WorktreeHeadIdentityRefreshState
): void {
  clearTimeout(state.rebaselineTimer ?? undefined)
  state.rebaselineTimer = null
}

/** Scoped passes arm one catch-up timer; full passes disarm it, leaving idle repos unscheduled. */
function scheduleRebaseline(
  host: HeadIdentityWatchHost,
  state: WorktreeHeadIdentityRefreshState
): void {
  disposeWorktreeHeadIdentityRefreshState(state)
  if (host.disposed || host.mainWindow.isDestroyed()) {
    return
  }
  const dueInMs = Math.max(
    0,
    state.lastFullReadAtMs + HEAD_IDENTITY_FULL_REBASELINE_INTERVAL_MS - Date.now()
  )
  const timer = setTimeout(() => {
    state.rebaselineTimer = null
    // No structural refresh accompanies this timer; emit corrections rather than silently rebaselining.
    void refreshWorktreeHeadIdentities(host, state, true, FULL_HEAD_IDENTITY_SCOPE)
  }, dueInMs)
  timer.unref?.()
  state.rebaselineTimer = timer
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

/** Publish actual head moves; structural callers rebaseline silently because their catalog refresh carries the heads. */
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
  // Fold stranded queued scopes into the next live request after macOS window replacement.
  const requestedScope = state.queuedScope
    ? mergeHeadIdentityScopes(state.queuedScope, scope)
    : scope
  const requestedEmit = emit || state.queuedEmit
  state.queuedScope = null
  state.queuedEmit = false
  // Promote before skipping empty scope so structural-only churn cannot starve full rereads.
  const effectiveScope = resolveScope(state, requestedScope)
  // Empty scopes prove no head moved; promoted structural passes stay silent because catalog notification covers every repo.
  if (state.baseline !== null && isEmptyHeadIdentityScope(effectiveScope)) {
    return
  }
  state.inFlight = true
  try {
    const { identities, complete } = await readGitCommonHeadIdentities(
      host.path,
      state.cache,
      effectiveScope
    )
    if (host.disposed || host.mainWindow.isDestroyed()) {
      return
    }
    // Discarded or incomplete reads cannot establish a full freshness checkpoint.
    if (effectiveScope.all && complete) {
      state.lastFullReadAtMs = Date.now()
    }
    const baseline = state.baseline
    // Preserve unseen rows so recovered listings do not falsely report every head as changed.
    const nextBaseline = complete ? new Map<string, string>() : new Map(baseline ?? [])
    for (const identity of identities) {
      nextBaseline.set(identity.worktreePath, headIdentitySignature(identity))
    }
    // Silent head-moving passes accompany structural catalog notification, which publishes the authoritative heads.
    const changed =
      baseline && requestedEmit
        ? identities.filter(
            (identity) => baseline.get(identity.worktreePath) !== headIdentitySignature(identity)
          )
        : []
    for (const repoId of changed.length > 0 ? host.repos.keys() : []) {
      notifyWorktreeHeadIdentitiesChanged(host.mainWindow, repoId, changed)
    }
    // Commit baseline after notification so a partial send failure retries instead of burying the move.
    state.baseline = nextBaseline
  } catch (error) {
    console.warn(`[worktree-base-watcher] head identity read failed for ${host.path}:`, error)
    // Failed reads invalidate partial memo state; force a full refresh next time.
    state.cache = createWorktreeHeadIdentityCache()
    state.lastFullReadAtMs = 0
  } finally {
    state.inFlight = false
    if (state.queuedScope && !host.disposed) {
      // Keep queued scope for a later live-window call if this rerun cannot proceed.
      void refreshWorktreeHeadIdentities(host, state, state.queuedEmit, state.queuedScope)
    } else if (effectiveScope.all) {
      // Do not rearm after a full pass, including failures that would otherwise spin on persistent filesystem errors.
      disposeWorktreeHeadIdentityRefreshState(state)
    } else {
      scheduleRebaseline(host, state)
    }
  }
}
