import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { addWorkspaceSessionWorktreeOwners } from '../restoring-sessions/session-worktree-ownership'
import { splitWorktreeId } from '../../../shared/worktree/id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { SESSION_FIELDS_PRUNED_BY_OWNER_KEY } from '../../orca-profiles/profile-project-session-field-disposition'
import { ownerKeyWorktreeIds } from '../../orca-profiles/profile-project-worktree-identity'

/** Paired-host catalogs live on the remote host. */
const isPairedHost = (hostId: string | null | undefined): boolean =>
  parseExecutionHostId(hostId)?.kind === 'runtime'

function ownerKeyRepoIds(ownerKey: string | null | undefined): string[] {
  return ownerKey
    ? ownerKeyWorktreeIds(ownerKey).flatMap((worktreeId) => {
        const repoId = splitWorktreeId(worktreeId)?.repoId
        return repoId ? [repoId] : []
      })
    : []
}

/** Retain paired-host rows: their absent local catalog cannot prove deletion before pairing (#17776). */
export function collectDeregisteredRepoIds(state: PersistedState): Set<string> {
  const liveRepoIds = new Set(state.repos.map((repo) => repo.id))
  const retainOwner = (ownerKey: string | null | undefined): void => {
    for (const repoId of ownerKeyRepoIds(ownerKey)) {
      liveRepoIds.add(repoId)
    }
  }
  // This walker requires the shape but uses only addOwner.
  const retainCollector = { owners: new Set<string>(), addOwner: retainOwner }
  for (const [hostId, session] of Object.entries(state.workspaceSessionsByHostId ?? {})) {
    if (session && isPairedHost(hostId)) {
      addWorkspaceSessionWorktreeOwners(session, retainCollector)
    }
  }
  for (const [worktreeId, meta] of Object.entries(state.worktreeMeta)) {
    if (isPairedHost(meta.hostId)) {
      retainOwner(worktreeId)
    }
  }
  for (const alias of Object.keys(state.worktreeIdentityAliases ?? {})) {
    if (isPairedHost(getExecutionHostIdFromWorktreeHostIdentity(alias))) {
      retainOwner(getWorktreeIdFromHostIdentity(alias))
    }
  }
  // Staged imports own recovery rows before repo registration.
  for (const staged of state.orcadMigrationStagedCatalogs ?? []) {
    for (const repo of staged.manifest.payload.repositories) {
      liveRepoIds.add(repo.id)
    }
  }
  const orphanRepoIds = new Set<string>()
  // Only full repo::path locators prove repo identity; bare folder/revision keys could delete live sessions.
  const addWorktreeId = (worktreeId: string | null | undefined): void => {
    const repoId = worktreeId ? splitWorktreeId(worktreeId)?.repoId : undefined
    if (repoId && !liveRepoIds.has(repoId)) {
      orphanRepoIds.add(repoId)
    }
  }
  /** Ambiguous owner keys seed removal only when neither reading names a live repo. */
  const addOwnerKey = (ownerKey: string): void => {
    const repoIds = ownerKeyRepoIds(ownerKey)
    if (repoIds.length > 0 && repoIds.every((repoId) => !liveRepoIds.has(repoId))) {
      for (const repoId of repoIds) {
        orphanRepoIds.add(repoId)
      }
    }
  }

  // Retain bounded presets/name registries; reissuing retired names could collide with old agent state.
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
    // These references bypass owner-indexed pruning and need explicit collection.
    for (const ownerKey of [
      session.activeWorktreeId,
      session.activeWorkspaceKey,
      ...(session.activeWorktreeIdsOnShutdown ?? [])
    ]) {
      if (ownerKey) {
        addOwnerKey(ownerKey)
      }
    }
    // Bare repo-keyed revisions cannot prove ownership; locator evidence seeds their eventual cleanup.
    for (const record of Object.values(session.sleepingAgentSessionsByPaneKey ?? {})) {
      addWorktreeId(record.worktreeId)
    }
    for (const tombstone of Object.values(session.terminalSurfaceTombstonesByPaneKey ?? {})) {
      addWorktreeId(tombstone.worktreeId)
    }
    for (const record of Object.values(session.closedTerminalTabTombstonesByTabId ?? {})) {
      addWorktreeId(record.worktreeId)
    }
  }
  return orphanRepoIds
}
