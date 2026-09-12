import { randomUUID } from 'node:crypto'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  parseOrcadMigrationManifest,
  type OrcadMigrationDormantStatePayload,
  type OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { collectOrcadMigrationSourceCatalog } from '../persistence/migrating-orcad-catalog/orcad-source-catalog'
import { computeOrcadMigrationManifestSha256 } from '../orcad/orcad-migration-manifest-digest'
import type { OrcadSourceLiveProjection } from '../persistence/migrating-orcad-catalog/orcad-source-cutover-context'

export function createOrcadMigrationManifest(
  store: Pick<
    Store,
    | 'collectOrcadMigrationSourceDormantState'
    | 'getFolderWorkspaces'
    | 'getProjectGroups'
    | 'getRepos'
  >,
  target: SshTarget,
  options: {
    migrationId?: string
    now?: () => Date
    destinationEnvironmentId?: string
    projectLiveSource?: OrcadSourceLiveProjection
  } = {}
): OrcadMigrationManifest {
  const payload = collectOrcadMigrationSourceCatalog(store, target)
  const source = {
    sshTargetId: target.id,
    sshTargetGeneration: target.generation ?? null,
    targetLabel: target.label
  }
  const dormantState =
    typeof store.collectOrcadMigrationSourceDormantState === 'function'
      ? store.collectOrcadMigrationSourceDormantState(
          source,
          payload,
          options.destinationEnvironmentId,
          options.projectLiveSource
        )
      : emptyDormantState()
  const unsigned = {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: options.migrationId ?? randomUUID(),
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    source,
    payload: {
      ...payload,
      ...(hasDormantState(dormantState) ? { dormantState } : {})
    },
    ...(options.destinationEnvironmentId
      ? { destinationEnvironmentId: options.destinationEnvironmentId }
      : {})
  }
  return parseOrcadMigrationManifest({
    ...unsigned,
    manifestSha256: computeOrcadMigrationManifestSha256(unsigned)
  })
}

function emptyDormantState(): OrcadMigrationDormantStatePayload {
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

function hasDormantState(
  state: ReturnType<Store['collectOrcadMigrationSourceDormantState']>
): boolean {
  return (
    state.worktreeMeta.length > 0 ||
    state.worktreeLineage.length > 0 ||
    state.workspaceLineage.length > 0 ||
    state.sparsePresets.length > 0 ||
    state.retiredWorktreeNames.length > 0 ||
    state.retiredWorktreeNamespaces.length > 0 ||
    state.workspaceSession !== undefined ||
    (state.terminalScrollbackSnapshots?.length ?? 0) > 0 ||
    (state.automations?.length ?? 0) > 0 ||
    (state.automationRuns?.length ?? 0) > 0 ||
    (state.clientState !== undefined && Object.keys(state.clientState).length > 0)
  )
}
