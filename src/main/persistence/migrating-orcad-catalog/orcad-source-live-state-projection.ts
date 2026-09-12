import type { PersistedState } from '../../../shared/persisted-state-types'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import type {
  OrcadMigrationManifestSource,
  OrcadMigrationCatalogPayload
} from '../../../shared/orcad-migration-manifest'
import type { PtyOwnershipTransferWireIdentity } from '../../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferSurfaceBinding } from '../../../shared/pty-ownership-transfer-surface-binding'
import { createOrcadMigrationSourceScope } from './orcad-source-scope'
import { projectOrcadSourceLiveSession } from './orcad-source-live-session-projection'
import { sessionPartitions } from './orcad-source-workspace-session-fragments'
import { foldOrcadSourceSessionMirror } from './orcad-source-session-mirror'

/** Only caller-authenticated complete lease coverage may be removed from this comparison clone. */
export function projectOrcadSourceLiveState(
  state: PersistedState,
  source: OrcadMigrationManifestSource,
  catalog: OrcadMigrationCatalogPayload,
  admitted: {
    bindings: readonly {
      identity: PtyOwnershipTransferWireIdentity
      surfaceBinding: PtyOwnershipTransferSurfaceBinding
    }[]
    leases: PersistedState['sshRemotePtyLeases']
    recovery: NonNullable<PersistedState['sshPtyConsumerRecoveries']>[number]
  }
) {
  const scope = createOrcadMigrationSourceScope({ source, catalog })
  const leases = state.sshRemotePtyLeases.filter((lease) => lease.targetId === scope.targetId)
  const recoveries = (state.sshPtyConsumerRecoveries ?? []).filter(
    (entry) => entry.targetId === scope.targetId
  )
  if (
    serializeOrcadMigrationValue(leases) !== serializeOrcadMigrationValue(admitted.leases) ||
    serializeOrcadMigrationValue(recoveries) !== serializeOrcadMigrationValue([admitted.recovery])
  ) {
    throw new Error('orcad_migration_source_live_evidence_changed')
  }
  const comparison = structuredClone(state)
  const partitions = sessionPartitions(comparison, 'local')
  const assignments = new Map<string, (typeof admitted.bindings)[number][]>()
  const mirrored: (typeof admitted.bindings)[number][] = []
  for (const binding of admitted.bindings) {
    const matches = partitions.filter(([, session]) =>
      Object.values(session.tabsByWorktree).some((tabs) =>
        tabs.some((tab) => tab.id === binding.surfaceBinding.tabId)
      )
    )
    if (
      !matches.length ||
      matches.length > 2 ||
      matches.some(([host]) => host !== 'local' && host !== scope.hostId)
    ) {
      throw new Error('orcad_migration_source_live_partition_conflict')
    }
    if (matches.length === 2) {
      mirrored.push(binding)
    }
    for (const [host] of matches) {
      assignments.set(host, [...(assignments.get(host) ?? []), binding])
    }
  }
  if (mirrored.length) {
    const host = comparison.workspaceSessionsByHostId![scope.hostId]!
    projectOrcadSourceLiveSession(host, scope, mirrored)
    const local = comparison.workspaceSession
    local.terminalPtyIncarnationsByPaneKey ??= {}
    for (const { identity, surfaceBinding } of mirrored) {
      const pane = `${surfaceBinding.tabId}:${surfaceBinding.leafId}`
      // A missing UI mirror field may borrow authenticated host evidence, never replace it.
      local.terminalPtyIncarnationsByPaneKey[pane] ??= identity.incarnationId
    }
  }
  for (const [host, bindings] of assignments) {
    const session =
      host === 'local'
        ? comparison.workspaceSession
        : comparison.workspaceSessionsByHostId![
            host as keyof NonNullable<typeof comparison.workspaceSessionsByHostId>
          ]!
    const projected = projectOrcadSourceLiveSession(session, scope, bindings)
    if (host === 'local') {
      comparison.workspaceSession = projected
    } else {
      comparison.workspaceSessionsByHostId![
        host as keyof NonNullable<typeof comparison.workspaceSessionsByHostId>
      ] = projected
    }
  }
  if (mirrored.length) {
    const folded = foldOrcadSourceSessionMirror(
      comparison.workspaceSession,
      comparison.workspaceSessionsByHostId![scope.hostId]!,
      scope
    )
    comparison.workspaceSession = folded.local
    comparison.workspaceSessionsByHostId![scope.hostId] = folded.host
  }
  const terminals = new Set(admitted.bindings.map(({ identity }) => identity.terminalId))
  if (
    leases
      .filter((lease) => lease.state !== 'terminated')
      .some((lease) => !terminals.has(lease.ptyId))
  ) {
    throw new Error('orcad_migration_source_live_lease_uncovered')
  }
  comparison.sshRemotePtyLeases = comparison.sshRemotePtyLeases.filter(
    (lease) => lease.targetId !== scope.targetId || !terminals.has(lease.ptyId)
  )
  comparison.sshPtyConsumerRecoveries = comparison.sshPtyConsumerRecoveries?.filter(
    (entry) => entry.targetId !== scope.targetId
  )
  return comparison
}
