import type { Store } from '../../persistence/loading-store/store'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { isRepoOnCatalogHost } from '../../../shared/execution-host'
import { getOtherProfileWorktreeIdsForHistoryGc } from '../../orca-profiles/catalog/other-profile-workspace-catalog'
import {
  addWorkspaceSessionWorktreeOwners,
  createWorktreeOwnerCandidateCollector
} from '../../persistence/restoring-sessions/session-worktree-ownership'
import type { HistoryGcOwners } from './terminal-history-gc'

/** Include git and folder:<id> PTY workspace keys; omitting folder workspaces makes their live shell history appear orphaned. */
export function getKnownWorktreeIdsForHistoryGc(
  store: Pick<
    Store,
    | 'getAllWorktreeMeta'
    | 'getFolderWorkspaces'
    | 'getRepos'
    | 'getWorkspaceSession'
    | 'getWorkspaceSessionHostIds'
  >,
  readOtherProfiles = getOtherProfileWorktreeIdsForHistoryGc
): Omit<HistoryGcOwners, 'liveSessionIds'> {
  const live = new Set<string>()
  for (const [worktreeId, meta] of Object.entries(store.getAllWorktreeMeta())) {
    live.add(worktreeId)
    // A renamed worktree's panes keep session ids that embed its old path.
    meta.priorWorktreeIds?.forEach((id) => live.add(id))
  }
  for (const workspace of store.getFolderWorkspaces()) {
    live.add(folderWorkspaceKey(workspace.id))
  }
  // History spans profiles; include all owners. If any profile is unreadable, return empty (prune nothing), never a destructive partial set.
  const others = readOtherProfiles()
  if (others.unreadableProfiles > 0) {
    console.warn(
      `[pty:history:gc] Skipping GC: ${others.unreadableProfiles} profile(s) could not be read`
    )
    return { liveWorktreeIds: new Set(), localRepoPaths: new Map(), referencedSessionIds }
  }
  for (const id of others.ids) {
    live.add(id)
  }
  return {
    liveWorktreeIds: live,
    localRepoPaths: localOnlyRepoPaths(store, others.repoIds),
    referencedSessionIds
  }

  function referencedSessionIds(
    candidates: readonly { sessionId: string; worktreeId: string }[]
  ): Set<string> {
    const sessions = store.getWorkspaceSessionHostIds().map((id) => store.getWorkspaceSession(id))
    const collector = createWorktreeOwnerCandidateCollector(
      new Set(candidates.map((candidate) => candidate.worktreeId))
    )
    for (const session of sessions) {
      addWorkspaceSessionWorktreeOwners(session, collector)
    }
    // Any field may hold a pane's session id (tabs, layouts, sleep rows), so match ids anywhere.
    const named = collectMatchingStrings(sessions, new Set(candidates.map((c) => c.sessionId)))
    return new Set(
      candidates
        .filter(
          ({ sessionId, worktreeId }) => collector.owners.has(worktreeId) || named.has(sessionId)
        )
        .map(({ sessionId }) => sessionId)
    )
  }
}

function collectMatchingStrings(root: unknown, wanted: ReadonlySet<string>): Set<string> {
  const found = new Set<string>()
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const value = stack.pop()
    if (typeof value === 'string') {
      if (wanted.has(value)) {
        found.add(value)
      }
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (wanted.has(key)) {
          found.add(key)
        }
        stack.push(child)
      }
    }
  }
  return found
}

/** A local stat can only prove a worktree gone for repos this machine alone hosts. */
function localOnlyRepoPaths(
  store: Pick<Store, 'getRepos'>,
  otherProfileRepoIds: ReadonlySet<string>
): Map<string, string> {
  const paths = new Map<string, string>()
  const remote = new Set(otherProfileRepoIds)
  for (const repo of store.getRepos()) {
    if (isRepoOnCatalogHost(repo)) {
      paths.set(repo.id, repo.path)
    } else {
      remote.add(repo.id)
    }
  }
  for (const id of remote) {
    paths.delete(id)
  }
  return paths
}
