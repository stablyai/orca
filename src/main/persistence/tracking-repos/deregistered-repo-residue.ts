import type { PersistedState } from '../../../shared/persisted-state-types'
import { getWorktreeIdFromHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { splitWorktreeId } from '../../../shared/worktree/id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { SESSION_FIELDS_PRUNED_BY_OWNER_KEY } from '../../orca-profiles/profile-project-session-field-disposition'
import { ownerKeyWorktreeIds } from '../../orca-profiles/profile-project-worktree-identity'

/**
 * Repo ids that still own persisted rows but no longer appear in `state.repos`.
 *
 * Why nothing else finds them: every other sweeper is gated on the repo still being registered, so
 * deregistering a project stranded the rows it owned permanently — including a paired client's
 * mirror of a remote host's session partition, which no local repo removal can reach (#17776).
 */
export function collectDeregisteredRepoIds(state: PersistedState): Set<string> {
  const liveRepoIds = new Set(state.repos.map((repo) => repo.id))
  const orphanRepoIds = new Set<string>()
  // Only a full `<repoId>::<path>` locator seeds the set. A bare key -- a folder workspace id, a
  // repo-keyed topology revision, a test-shaped locator -- cannot be told apart from a repo id, and
  // guessing wrong here deletes live session state.
  const addWorktreeId = (worktreeId: string | null | undefined): void => {
    const repoId = worktreeId ? splitWorktreeId(worktreeId)?.repoId : undefined
    if (repoId && !liveRepoIds.has(repoId)) {
      orphanRepoIds.add(repoId)
    }
  }
  /**
   * Seed from an owner key, which can read as two different locators (see `ownerKeyWorktreeIds`).
   * All or nothing: if either reading names a live repo the key is that repo's, and seeding the
   * other reading would hand the removal pass -- which accepts either -- a live row to delete.
   */
  const addOwnerKey = (ownerKey: string): void => {
    const repoIds = ownerKeyWorktreeIds(ownerKey).flatMap((worktreeId) => {
      const repoId = splitWorktreeId(worktreeId)?.repoId
      return repoId ? [repoId] : []
    })
    if (repoIds.length > 0 && repoIds.every((repoId) => !liveRepoIds.has(repoId))) {
      for (const repoId of repoIds) {
        orphanRepoIds.add(repoId)
      }
    }
  }

  // Deliberately not seeded from `sparsePresetsByRepo` or `retiredWorktreeNamesByRepo`: both are
  // bounded, and dropping a retired-name row would let a re-added repo reissue a name onto a cwd
  // that still holds a prior occupant's agent state.
  for (const worktreeId of Object.keys(state.worktreeMeta)) {
    addWorktreeId(worktreeId)
  }
  for (const alias of Object.keys(state.worktreeIdentityAliases ?? {})) {
    addWorktreeId(getWorktreeIdFromHostIdentity(alias))
  }
  for (const [childId, lineage] of Object.entries(state.worktreeLineageById)) {
    addWorktreeId(childId)
    addWorktreeId(lineage.parentWorktreeId)
  }
  for (const [childKey, lineage] of Object.entries(state.workspaceLineageByChildKey)) {
    addOwnerKey(childKey)
    addOwnerKey(lineage.parentWorkspaceKey)
  }
  for (const selections of Object.values(state.mobileClientTabSelectionsByDeviceId ?? {})) {
    for (const worktreeId of Object.keys(selections)) {
      addWorktreeId(worktreeId)
    }
  }
  const sessions: (WorkspaceSessionState | undefined)[] = [
    state.workspaceSession,
    ...Object.values(state.workspaceSessionsByHostId ?? {})
  ]
  for (const session of sessions) {
    if (!session) {
      continue
    }
    for (const field of SESSION_FIELDS_PRUNED_BY_OWNER_KEY) {
      for (const ownerKey of Object.keys(
        (session[field] as Record<string, unknown> | undefined) ?? {}
      )) {
        addOwnerKey(ownerKey)
      }
    }
    for (const ownerKey of Object.keys(session.tabsByWorktree ?? {})) {
      addOwnerKey(ownerKey)
    }
    for (const ownerKey of Object.keys(session.browserTabsByWorktree ?? {})) {
      addOwnerKey(ownerKey)
    }
    // Pruned by bespoke rules rather than by owner key, so the loop above never reaches them.
    for (const ownerKey of [
      session.activeWorktreeId,
      session.activeWorkspaceKey,
      ...(session.activeWorktreeIdsOnShutdown ?? [])
    ]) {
      if (ownerKey) {
        addOwnerKey(ownerKey)
      }
    }
    // Not seeded from `terminalTopologyRevisionByRepoId`: its keys are bare repo ids by contract,
    // and a bare key is exactly what `addWorktreeId` refuses to trust. Rows there are removed once
    // any locator seeds their repo id, which every repo that ever opened a terminal has.
    for (const record of Object.values(session.sleepingAgentSessionsByPaneKey ?? {})) {
      addWorktreeId(record.worktreeId)
    }
    for (const tombstone of Object.values(session.terminalSurfaceTombstonesByPaneKey ?? {})) {
      addWorktreeId(tombstone.worktreeId)
    }
  }
  return orphanRepoIds
}
