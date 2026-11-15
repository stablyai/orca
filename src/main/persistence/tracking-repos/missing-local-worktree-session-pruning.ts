import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { worktreeRetentionIdComparisonKey } from '../../workspaces/catalog/worktree-retention-path-comparison'
import {
  createWorktreeOwnerCandidateCollector,
  getPersistedWorktreeOwnerId
} from '../restoring-sessions/session-worktree-ownership'
import { sessionFieldsRemovedWithWorkspace } from '../../orca-profiles/project-transfer/profile-project-session-field-disposition'

type OwnerRow = { worktreeId?: string } | undefined
const OWNER_KEYED_FIELDS = [
  'tabsByWorktree',
  'browserTabsByWorktree',
  'lastVisitedAtByWorktreeId',
  ...sessionFieldsRemovedWithWorkspace('ownerKey')
] as const
const OWNER_ROW_FIELDS = sessionFieldsRemovedWithWorkspace('ownerRow')
import {
  removeWorkspaceSessionOwners,
  withoutWslMoveFrozenOwners
} from '../restoring-sessions/session-owner-removal'
import {
  indexMetadataAliasesForWorktreeIds,
  isLocallyRemovableWorktreeMetadataRow,
  type NativeLocalWorktreeMetadataScanExpectation
} from './local-worktree-metadata-scan-expectation'
import {
  addNonSessionWorkspaceOwners,
  isValidCandidateId,
  repoStillMatches,
  routingStillMatches
} from './missing-local-worktree-metadata-pruning'

/** Worktree IDs of this repo that only the local saved session still names. */
export function selectLocalWorktreeSessionOwnersForRepo(
  session: WorkspaceSessionState,
  repoId: string,
  platform = process.platform
): string[] {
  const owners = new Set<string>()
  const add = (ownerKey: string | null | undefined): void => {
    const worktreeId = getPersistedWorktreeOwnerId(ownerKey)
    if (
      worktreeId &&
      getRepoIdFromWorktreeId(worktreeId) === repoId &&
      isValidCandidateId(repoId, worktreeId, platform)
    ) {
      owners.add(worktreeId)
    }
  }
  // Only references removal deletes; a row filed under a live workspace must not re-arm cleanup.
  for (const field of OWNER_KEYED_FIELDS) {
    for (const key of Object.keys((session[field] ?? {}) as Record<string, unknown>)) {
      // Removal deletes host-qualified keys only from the recency map.
      if (field === 'lastVisitedAtByWorktreeId' || !isWorktreeHostIdentity(key)) {
        add(key)
      }
    }
  }
  for (const field of OWNER_ROW_FIELDS) {
    for (const row of Object.values((session[field] ?? {}) as Record<string, OwnerRow>)) {
      add(row?.worktreeId)
    }
  }
  session.activeWorktreeIdsOnShutdown?.forEach(add)
  return [...owners]
}

function hasUnsavedDraft(state: PersistedState, worktreeId: string): boolean {
  const ownerKeys = [worktreeId, worktreeWorkspaceKey(worktreeId)]
  return [state.workspaceSession, ...Object.values(state.workspaceSessionsByHostId ?? {})].some(
    (session) =>
      ownerKeys.some((ownerKey) =>
        session?.openFilesByWorktree?.[ownerKey]?.some(
          (file) => file.dirtyDraftContent !== undefined
        )
      )
  )
}

/** Comparison keys of metadata rows that still name a workspace (an archived checkout, another host). */
function protectedMetadataComparisonKeys(
  state: PersistedState,
  repoId: string,
  platform: NodeJS.Platform
): Set<string> {
  const ids = new Set<string>()
  for (const key of [
    ...Object.keys(state.worktreeMeta),
    ...Object.keys(state.worktreeIdentityAliases ?? {})
  ]) {
    const worktreeId = isWorktreeHostIdentity(key) ? getWorktreeIdFromHostIdentity(key) : key
    if (getRepoIdFromWorktreeId(worktreeId) === repoId) {
      ids.add(worktreeId)
    }
  }
  const aliasesByWorktreeId = indexMetadataAliasesForWorktreeIds(state, ids)
  const keys = new Set<string>()
  for (const worktreeId of ids) {
    const aliases = aliasesByWorktreeId.get(worktreeId) ?? []
    const comparisonKey = worktreeRetentionIdComparisonKey(worktreeId, platform)
    if (comparisonKey && !isLocallyRemovableWorktreeMetadataRow(state, worktreeId, aliases)) {
      keys.add(comparisonKey)
    }
  }
  return keys
}

/** Session-only owners a cleanup may drop: never the active workspace, an unsaved draft, a
 *  protected metadata row (matched path-equivalently) or a lease/automation/phone owner. */
export function selectRemovableLocalWorktreeSessionOwners(
  state: PersistedState,
  repoId: string,
  worktreeIds: readonly string[],
  platform = process.platform
): string[] {
  const candidateIds = new Set(
    worktreeIds.filter((worktreeId) => isValidCandidateId(repoId, worktreeId, platform))
  )
  if (candidateIds.size === 0) {
    return []
  }
  const collector = createWorktreeOwnerCandidateCollector(candidateIds, platform)
  addNonSessionWorkspaceOwners(state, collector)
  collector.addOwner(state.workspaceSession.activeWorktreeId)
  collector.addOwner(state.workspaceSession.activeWorkspaceKey)
  const protectedKeys = protectedMetadataComparisonKeys(state, repoId, platform)
  return [...candidateIds].filter(
    (worktreeId) =>
      !collector.owners.has(worktreeId) &&
      !hasUnsavedDraft(state, worktreeId) &&
      !protectedKeys.has(worktreeRetentionIdComparisonKey(worktreeId, platform) ?? '')
  )
}

/** Drop local saved session state for worktrees an authoritative scan no longer lists and whose
 *  folders are gone; ownership is rechecked because path probes yield. */
export function pruneMissingLocalWorktreeSessionsForRepo(
  state: PersistedState,
  scan: NativeLocalWorktreeMetadataScanExpectation,
  missingWorktreeIds: readonly string[],
  platform = process.platform
): string[] {
  if (
    missingWorktreeIds.length === 0 ||
    !repoStillMatches(state, scan.repo) ||
    !routingStillMatches(state, scan)
  ) {
    return []
  }
  // Only owners removal can delete count; any other reference would re-arm cleanup forever.
  const present = new Set(
    selectLocalWorktreeSessionOwnersForRepo(state.workspaceSession, scan.repo.id, platform)
  )
  const removedIds = selectRemovableLocalWorktreeSessionOwners(
    state,
    scan.repo.id,
    missingWorktreeIds.filter((worktreeId) => present.has(worktreeId)),
    platform
  )
  const ownerKeys = withoutWslMoveFrozenOwners(
    new Set(removedIds.flatMap((worktreeId) => [worktreeId, worktreeWorkspaceKey(worktreeId)]))
  )
  if (ownerKeys.size === 0) {
    return []
  }
  state.workspaceSession = removeWorkspaceSessionOwners(state.workspaceSession, ownerKeys)!
  return removedIds.filter((worktreeId) => ownerKeys.has(worktreeId))
}
