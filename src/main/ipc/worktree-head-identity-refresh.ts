import type { BrowserWindow } from 'electron'
import { notifyWorktreeHeadIdentitiesChanged } from './worktree-remote'
import { readGitCommonHeadIdentities } from './worktree-head-identity-reader'

type HeadIdentityWatchHost = {
  path: string
  repos: ReadonlyMap<string, unknown>
  mainWindow: BrowserWindow
  disposed: boolean
}

export type WorktreeHeadIdentityRefreshState = {
  /** worktreePath → `${head} ${branch} ${rebase-state}` from the last metadata-file read. */
  baseline: Map<string, string> | null
  inFlight: boolean
  queued: boolean
  queuedEmit: boolean
}

export function createWorktreeHeadIdentityRefreshState(): WorktreeHeadIdentityRefreshState {
  return { baseline: null, inFlight: false, queued: false, queuedEmit: false }
}

function headIdentitySignature(identity: {
  head: string
  branch: string | null
  rebasing?: boolean
  rebaseBranch?: string
}): string {
  // Why: `git rebase --quit` flips only the rebase fields (HEAD stays put); omitting them
  // would swallow the change and leave a stale "(rebasing)" badge until the next poll.
  return `${identity.head} ${identity.branch ?? ''} ${identity.rebasing ? `rebasing:${identity.rebaseBranch ?? ''}` : ''}`
}

/** Diffs metadata-file head reads against the previous baseline and notifies
 *  only actual head moves, so status-only churn (index rewrites from external
 *  `git status`) stays silent and never re-enters structural fanout. Passing
 *  `emit: false` re-baselines without notifying — structural ticks already
 *  run the authoritative worktree listing. */
export async function refreshWorktreeHeadIdentities(
  host: HeadIdentityWatchHost,
  state: WorktreeHeadIdentityRefreshState,
  emit: boolean
): Promise<void> {
  if (host.disposed || host.mainWindow.isDestroyed()) {
    return
  }
  if (state.inFlight) {
    state.queued = true
    state.queuedEmit ||= emit
    return
  }
  state.inFlight = true
  try {
    const identities = await readGitCommonHeadIdentities(host.path)
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
  } finally {
    state.inFlight = false
    if (state.queued && !host.disposed) {
      const queuedEmit = state.queuedEmit
      state.queued = false
      state.queuedEmit = false
      void refreshWorktreeHeadIdentities(host, state, queuedEmit)
    }
  }
}
