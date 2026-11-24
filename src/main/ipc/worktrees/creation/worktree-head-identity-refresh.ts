import type { BrowserWindow } from 'electron'
import { notifyWorktreeHeadIdentitiesChanged } from '../worktree-remote'
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

// Keys stay with the callback: merging into a full scope drops entry names.
type UnverifiedHeadFallback = { entryKeys: ReadonlySet<string>; run: () => void }

export type WorktreeHeadIdentityRefreshState = {
  /** worktreePath → `${head} ${branch}` from the last metadata-file read. */
  baseline: Map<string, string> | null
  cache: WorktreeHeadIdentityCache
  lastFullReadAtMs: number
  inFlight: boolean
  queuedScope: WorktreeHeadIdentityScope | null
  queuedEmit: boolean
  /** Callers whose freshness depends on the next pass publishing their entries' heads. */
  queuedUnverified: UnverifiedHeadFallback[]
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
    queuedUnverified: [],
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

/** Publish actual head moves; structural callers rebaseline silently because their catalog refresh carries the heads.
 *  `onUnverified` runs when this request's pass fails or cannot prove every head was published. */
export async function refreshWorktreeHeadIdentities(
  host: HeadIdentityWatchHost,
  state: WorktreeHeadIdentityRefreshState,
  emit: boolean,
  scope: WorktreeHeadIdentityScope = FULL_HEAD_IDENTITY_SCOPE,
  onUnverified?: () => void
): Promise<void> {
  if (host.disposed || host.mainWindow.isDestroyed()) {
    return
  }
  if (onUnverified) {
    state.queuedUnverified.push({ entryKeys: scope.entryNames, run: onUnverified })
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
  const unverifiedCallbacks = state.queuedUnverified
  state.queuedScope = null
  state.queuedEmit = false
  state.queuedUnverified = []
  let read: { complete: boolean; headlessEntryKeys: ReadonlySet<string> } | null = null
  // Promote before skipping empty scope so structural-only churn cannot starve full rereads.
  const effectiveScope = resolveScope(state, requestedScope)
  // Empty scopes prove no head moved; promoted structural passes stay silent because catalog notification covers every repo.
  if (state.baseline !== null && isEmptyHeadIdentityScope(effectiveScope)) {
    return
  }
  state.inFlight = true
  try {
    const { identities, complete, headlessEntryKeys } = await readGitCommonHeadIdentities(
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
    // Silent head-moving passes accompany structural catalog notification, which publishes the authoritative heads;
    // an emitting request queued mid-pass would diff against this baseline, so publish its moves now.
    const changed =
      baseline && (requestedEmit || state.queuedEmit)
        ? identities.filter(
            (identity) => baseline.get(identity.worktreePath) !== headIdentitySignature(identity)
          )
        : []
    for (const repoId of changed.length > 0 ? host.repos.keys() : []) {
      notifyWorktreeHeadIdentitiesChanged(host.mainWindow, repoId, changed)
    }
    if (baseline === null) {
      // This first baseline absorbs moves queued mid-read, so their next pass cannot publish them either.
      unverifiedCallbacks.push(...state.queuedUnverified.splice(0))
    }
    // Commit baseline after notification so a partial send failure retries instead of burying the move.
    state.baseline = nextBaseline
    // Without a prior baseline nothing was diffed, so no move could have been published.
    read = baseline === null ? null : { complete, headlessEntryKeys }
  } catch (error) {
    console.warn(`[worktree-base-watcher] head identity read failed for ${host.path}:`, error)
    // Failed reads invalidate partial memo state; force a full refresh next time.
    state.cache = createWorktreeHeadIdentityCache()
    state.lastFullReadAtMs = 0
  } finally {
    state.inFlight = false
    if (!host.disposed && !host.mainWindow.isDestroyed()) {
      for (const fallback of unverifiedCallbacks) {
        // A headless entry (orphan branch) has no identity to publish.
        if (
          !read?.complete ||
          [...fallback.entryKeys].some((key) => read?.headlessEntryKeys.has(key))
        ) {
          fallback.run()
        }
      }
    }
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
