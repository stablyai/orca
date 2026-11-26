import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
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

const OWNER_KEYED_FIELDS = [
  'tabsByWorktree',
  'browserTabsByWorktree',
  'lastVisitedAtByWorktreeId',
  ...sessionFieldsRemovedWithWorkspace('ownerKey')
] as const
const OWNER_ROW_FIELDS = sessionFieldsRemovedWithWorkspace('ownerRow')
import {
  removeWorkspaceSessionOwners,
  sessionRowWorktreeId,
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
    for (const key of Object.keys(session[field] ?? {})) {
      // Removal deletes host-qualified keys only from the recency map.
      if (field === 'lastVisitedAtByWorktreeId' || !isWorktreeHostIdentity(key)) {
        add(key)
      }
    }
  }
  for (const field of OWNER_ROW_FIELDS) {
    for (const row of Object.values(session[field] ?? {})) {
      const worktreeId = sessionRowWorktreeId(row)
      // Removal matches row owners exactly, so a host-qualified one would never be deleted.
      if (worktreeId && !isWorktreeHostIdentity(worktreeId)) {
        add(worktreeId)
      }
    }
  }
  session.activeWorktreeIdsOnShutdown?.forEach(add)
  return [...owners]
}

/** Which candidate comparison keys hold an unsaved draft in any partition; only candidates' files are read. */
function draftedCandidateKeys(
  state: PersistedState,
  candidateKeys: ReadonlySet<string>,
  platform: NodeJS.Platform
): Set<string> {
  const drafted = new Set<string>()
  for (const session of [
    state.workspaceSession,
    ...Object.values(state.workspaceSessionsByHostId ?? {})
  ]) {
    for (const [ownerKey, files] of Object.entries(session?.openFilesByWorktree ?? {})) {
      const worktreeId = getPersistedWorktreeOwnerId(ownerKey)
      const key = worktreeId ? worktreeRetentionIdComparisonKey(worktreeId, platform) : null
      if (
        key &&
        candidateKeys.has(key) &&
        files.some((file) => file.dirtyDraftContent !== undefined)
      ) {
        drafted.add(key)
      }
    }
  }
  return drafted
}

// Session cleanup also keeps a workspace hidden with isArchived and no archived checkout.
function isArchivedMetadataRow(
  state: PersistedState,
  worktreeId: string,
  aliases: readonly (readonly [alias: string, identityKeys: string[]])[]
): boolean {
  return (
    state.worktreeMeta[worktreeId]?.isArchived === true ||
    aliases.some(([, identityKeys]) =>
      identityKeys.some((key) => state.worktreeMetaByIdentity?.[key]?.isArchived === true)
    )
  )
}

/** Comparison keys of metadata rows that still name a workspace (archived, another host). */
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
    if (
      comparisonKey &&
      (isArchivedMetadataRow(state, worktreeId, aliases) ||
        !isLocallyRemovableWorktreeMetadataRow(state, worktreeId, aliases))
    ) {
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
  const comparisonKey = (worktreeId: string): string =>
    worktreeRetentionIdComparisonKey(worktreeId, platform) ?? ''
  const eligible = [...candidateIds].filter(
    (worktreeId) =>
      !collector.owners.has(worktreeId) && !protectedKeys.has(comparisonKey(worktreeId))
  )
  if (eligible.length === 0) {
    return []
  }
  const drafted = draftedCandidateKeys(state, new Set(eligible.map(comparisonKey)), platform)
  return eligible.filter((worktreeId) => !drafted.has(comparisonKey(worktreeId)))
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
