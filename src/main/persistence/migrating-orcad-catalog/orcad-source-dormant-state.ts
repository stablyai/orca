import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationDormantStatePayload,
  OrcadMigrationManifestSource
} from '../../../shared/orcad-migration/orcad-migration-manifest'
import type { OrcadMigrationDependencyKind } from '../../../shared/orcad-migration/orcad-migration-preflight'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TerminalScrollbackSnapshotStorage } from '../../terminal-scrollback-snapshots'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { isEmptyRetiredNameRegistry } from '../../../shared/worktree/retired-name-registry'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { toOrcadDestinationRepository } from './orcad-destination-catalog-projection'
import { collectOrcadMigrationRetiredWorktreeNamespaces } from './orcad-source-retired-worktree-names'
import { collectOrcadMigrationSourceAutomationState } from './orcad-source-automation-state'
import { collectOrcadMigrationSourceWorkspaceSession } from './orcad-source-workspace-session'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  unqualifyOrcadMigrationOwnerKey
} from './orcad-source-scope'
import { collectOrcadMigrationSourceClientState } from './orcad-source-client-state'
import { inspectOrcadSourceWorktreeMetadata } from './orcad-source-worktree-metadata'
import { compareKeys } from './orcad-source-key-order'

export const ORCAD_MIGRATION_TRANSFERRED_DORMANT_KINDS = [
  'worktree-metadata',
  'worktree-lineage',
  'workspace-lineage',
  'workspace-session',
  'automation',
  'automation-run',
  'sparse-preset',
  'retired-worktree-name',
  'mobile-tab-selection',
  'ui-routing',
  'saved-port-forward'
] as const satisfies readonly OrcadMigrationDependencyKind[]

type TransferredDormantKind = (typeof ORCAD_MIGRATION_TRANSFERRED_DORMANT_KINDS)[number]

export type OrcadMigrationSourceDormantInspection = {
  payload: OrcadMigrationDormantStatePayload
  blockedCounts: Record<TransferredDormantKind, number>
  /** Session blockers and remedies. */
  blockedSessionItems: string[]
  /** Retained on this desktop after confirmed "Move anyway". */
  leftBehindItems: string[]
}

/** Confirmed "Move anyway" permits retaining unsupported state; unsaved-draft blockers still apply. */
export function orcadMigrationLeavesBehind(state: PersistedState, targetId: string): boolean {
  return state.sshTargets.some(
    (target) => target.id === targetId && target.managedServerLeaveBehind !== undefined
  )
}

export function collectOrcadMigrationSourceDormantState(
  state: PersistedState,
  source: OrcadMigrationManifestSource,
  catalog: OrcadMigrationCatalogPayload,
  storage?: TerminalScrollbackSnapshotStorage,
  destinationEnvironmentId?: string
): OrcadMigrationSourceDormantInspection {
  const scope = createOrcadMigrationSourceScope({ source, catalog, repos: state.repos })
  const blockedCounts = emptyBlockedCounts()
  const destinationRepos = catalog.repositories.map(toOrcadDestinationRepository)
  const setupByRepoId = new Map(
    projectHostSetupProjectionFromRepos(destinationRepos).setups.flatMap((setup) =>
      setup.repoId ? [[setup.repoId, setup] as const] : []
    )
  )
  const metadata = inspectOrcadSourceWorktreeMetadata(state, scope)
  blockedCounts['worktree-metadata'] = metadata.blockedCount
  const worktreeMeta = uniqueDestinationRows(
    metadata.rows.flatMap(({ sourceKey, meta }) => {
      const worktreeId = unqualifyOrcadMigrationOwnerKey(sourceKey)
      const setup = setupByRepoId.get(getRepoIdFromWorktreeId(worktreeId))
      return [
        {
          sourceKey,
          worktreeId,
          meta: {
            ...structuredClone(meta),
            ...(setup ? { projectId: setup.projectId, projectHostSetupId: setup.id } : {}),
            hostId: 'local' as const
          }
        }
      ]
    }),
    (entry) => entry.worktreeId,
    () => (blockedCounts['worktree-metadata'] += 1)
  )
  const worktreeLineage = uniqueDestinationRows(
    Object.entries(state.worktreeLineageById).flatMap(([sourceKey, lineage]) => {
      const touches = [sourceKey, lineage.worktreeId, lineage.parentWorktreeId].some((value) =>
        orcadMigrationOwnerMatchesScope(value, scope)
      )
      if (!touches) {
        return []
      }
      const worktreeId = unqualifyOrcadMigrationOwnerKey(sourceKey)
      if (worktreeId !== lineage.worktreeId) {
        blockedCounts['worktree-lineage'] += 1
        return []
      }
      // Cross-host history belongs to the desktop and stays in its retained source profile.
      if (
        !orcadMigrationOwnerMatchesScope(lineage.worktreeId, scope) ||
        !orcadMigrationOwnerMatchesScope(lineage.parentWorktreeId, scope)
      ) {
        return []
      }
      return [{ sourceKey, worktreeId, lineage: structuredClone(lineage) }]
    }),
    (entry) => entry.worktreeId,
    () => (blockedCounts['worktree-lineage'] += 1)
  )
  const workspaceLineage = uniqueDestinationRows(
    Object.entries(state.workspaceLineageByChildKey).flatMap(([sourceKey, lineage]) => {
      const touches = [sourceKey, lineage.childWorkspaceKey, lineage.parentWorkspaceKey].some(
        (value) => orcadMigrationOwnerMatchesScope(value, scope)
      )
      if (!touches) {
        return []
      }
      const childWorkspaceKey = unqualifyOrcadMigrationOwnerKey(sourceKey)
      if (childWorkspaceKey !== lineage.childWorkspaceKey) {
        blockedCounts['workspace-lineage'] += 1
        return []
      }
      if (
        !orcadMigrationOwnerMatchesScope(lineage.childWorkspaceKey, scope) ||
        !orcadMigrationOwnerMatchesScope(lineage.parentWorkspaceKey, scope)
      ) {
        return []
      }
      return [
        {
          sourceKey,
          childWorkspaceKey,
          lineage: {
            ...structuredClone(lineage),
            childInstanceId: lineage.childInstanceId ?? null,
            parentInstanceId: lineage.parentInstanceId ?? null
          }
        }
      ]
    }),
    (entry) => entry.childWorkspaceKey,
    () => (blockedCounts['workspace-lineage'] += 1)
  )
  // Bare repo IDs shared across hosts cannot prove ownership.
  const ownedRepoIds = [...scope.repoIds].filter((repoId) => !scope.sharedRepoIds.has(repoId))
  const sparsePresets = ownedRepoIds
    .flatMap((repoId) => state.sparsePresetsByRepo[repoId] ?? [])
    .map((preset) => structuredClone(preset))
    .sort((left, right) =>
      compareKeys(`${left.repoId}\0${left.id}`, `${right.repoId}\0${right.id}`)
    )
  const retiredWorktreeNames = ownedRepoIds
    .flatMap((repoId) => {
      const registry = state.retiredWorktreeNamesByRepo?.[repoId]
      return registry && !isEmptyRetiredNameRegistry(registry)
        ? [{ repoId, registry: structuredClone(registry) }]
        : []
    })
    .sort((left, right) => compareKeys(left.repoId, right.repoId))
  const leaveBehind = orcadMigrationLeavesBehind(state, scope.targetId)
  const workspaceSession = collectOrcadMigrationSourceWorkspaceSession(
    state,
    source,
    catalog,
    storage,
    leaveBehind
  )
  const blockedSessionItems = [...workspaceSession.blockedItems]
  const automationState = collectOrcadMigrationSourceAutomationState(state, source, catalog)
  blockedCounts.automation = automationState.blockedAutomationCount
  blockedCounts['automation-run'] = automationState.blockedRunCount
  const clientState = collectOrcadMigrationSourceClientState(
    state,
    source,
    catalog,
    destinationEnvironmentId,
    workspaceSession.payload
  )
  blockedCounts['saved-port-forward'] = clientState.blockedCounts['saved-port-forward']
  const leftBehindItems = [...workspaceSession.leftBehindItems]
  const duplicateCloses = Array.from(
    { length: clientState.blockedCount },
    () => 'a browser page close saved twice'
  )
  // Duplicate closes stay behind; unsaved drafts still block even after "Move anyway".
  ;(leaveBehind ? leftBehindItems : blockedSessionItems).push(...duplicateCloses)
  blockedCounts['workspace-session'] = blockedSessionItems.length
  if (leaveBehind) {
    // These rows are excluded already; saved port conflicts are checked by the server.
    for (const kind of ORCAD_MIGRATION_TRANSFERRED_DORMANT_KINDS) {
      if (
        kind !== 'workspace-session' &&
        kind !== 'saved-port-forward' &&
        blockedCounts[kind] > 0
      ) {
        leftBehindItems.push(`${blockedCounts[kind]} saved ${kind} record(s)`)
        blockedCounts[kind] = 0
      }
    }
  }
  return {
    payload: {
      version: 1,
      worktreeMeta: worktreeMeta.sort((left, right) =>
        compareKeys(left.worktreeId, right.worktreeId)
      ),
      worktreeLineage: worktreeLineage.sort((left, right) =>
        compareKeys(left.worktreeId, right.worktreeId)
      ),
      workspaceLineage: workspaceLineage.sort((left, right) =>
        compareKeys(left.childWorkspaceKey, right.childWorkspaceKey)
      ),
      sparsePresets,
      retiredWorktreeNames,
      retiredWorktreeNamespaces: collectOrcadMigrationRetiredWorktreeNamespaces(state, catalog),
      ...(workspaceSession.payload ? { workspaceSession: workspaceSession.payload } : {}),
      ...(workspaceSession.snapshots.length > 0
        ? { terminalScrollbackSnapshots: workspaceSession.snapshots }
        : {}),
      ...(automationState.automations.length > 0
        ? { automations: automationState.automations }
        : {}),
      ...(automationState.automationRuns.length > 0
        ? { automationRuns: automationState.automationRuns }
        : {}),
      ...(clientState.payload ? { clientState: clientState.payload } : {})
    },
    blockedCounts,
    blockedSessionItems,
    leftBehindItems
  }
}

export function emptyDormantPayload(): OrcadMigrationDormantStatePayload {
  return {
    version: 1,
    worktreeMeta: [],
    worktreeLineage: [],
    workspaceLineage: [],
    sparsePresets: [],
    retiredWorktreeNames: [],
    retiredWorktreeNamespaces: []
  }
}

function uniqueDestinationRows<T>(
  rows: T[],
  key: (row: T) => string,
  onDuplicate: () => void
): T[] {
  const unique = new Map<string, T>()
  const duplicates = new Set<string>()
  for (const row of rows) {
    const rowKey = key(row)
    if (duplicates.has(rowKey)) {
      onDuplicate()
    } else if (unique.has(rowKey)) {
      unique.delete(rowKey)
      duplicates.add(rowKey)
      onDuplicate()
    } else {
      unique.set(rowKey, row)
    }
  }
  return [...unique.values()]
}

function emptyBlockedCounts(): Record<TransferredDormantKind, number> {
  return {
    'worktree-metadata': 0,
    'worktree-lineage': 0,
    'workspace-lineage': 0,
    'workspace-session': 0,
    automation: 0,
    'automation-run': 0,
    'sparse-preset': 0,
    'retired-worktree-name': 0,
    'mobile-tab-selection': 0,
    'ui-routing': 0,
    'saved-port-forward': 0
  }
}
