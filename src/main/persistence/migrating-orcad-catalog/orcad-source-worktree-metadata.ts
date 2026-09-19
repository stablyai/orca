import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { pruneUnreferencedWorktreeIdentityMeta } from '../loading-store/worktree-identity-metadata'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  unqualifyOrcadMigrationOwnerKey,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'

export function inspectOrcadSourceWorktreeMetadata(
  state: PersistedState,
  scope: OrcadMigrationSourceScope
) {
  const rows: { sourceKey: string; meta: WorktreeMeta }[] = []
  let blockedCount = 0
  for (const [sourceKey, meta] of Object.entries(state.worktreeMeta)) {
    const host = getExecutionHostIdFromWorktreeHostIdentity(sourceKey)
    if ((host && host !== scope.hostId) || (meta.hostId && meta.hostId !== scope.hostId)) {
      if (host === scope.hostId || meta.hostId === scope.hostId) {
        blockedCount++
      }
      continue
    }
    if (orcadMigrationOwnerMatchesScope(sourceKey, scope)) {
      rows.push({ sourceKey, meta })
    } else if (meta.hostId === scope.hostId || host === scope.hostId) {
      blockedCount++
    }
  }
  const referenced = new Set(Object.values(state.worktreeIdentityAliases ?? {}).flat())
  for (const [identity, meta] of Object.entries(state.worktreeMetaByIdentity ?? {})) {
    if (meta.hostId === scope.hostId && !referenced.has(identity)) {
      blockedCount++
    }
  }
  for (const [alias, identities] of Object.entries(state.worktreeIdentityAliases ?? {})) {
    if (getExecutionHostIdFromWorktreeHostIdentity(alias) !== scope.hostId) {
      continue
    }
    const meta = identities.length === 1 ? state.worktreeMetaByIdentity?.[identities[0]] : undefined
    const worktreeId = unqualifyOrcadMigrationOwnerKey(alias)
    if (
      isWorktreeHostIdentity(worktreeId) ||
      !orcadMigrationOwnerMatchesScope(alias, scope) ||
      !meta ||
      !meta.instanceId ||
      (meta.hostId !== undefined && meta.hostId !== scope.hostId) ||
      identities[0] !==
        canonicalWorktreeIdentity({
          worktreeId,
          executionHostId: scope.hostId,
          instanceId: meta.instanceId
        })
    ) {
      blockedCount++
      continue
    }
    const legacy = rows.filter(
      (row) => unqualifyOrcadMigrationOwnerKey(row.sourceKey) === worktreeId
    )
    if (
      legacy.length > 1 ||
      (legacy.length === 1 &&
        serializeOrcadMigrationValue({ ...legacy[0].meta, hostId: scope.hostId }) !==
          serializeOrcadMigrationValue({ ...meta, hostId: scope.hostId }))
    ) {
      // Neither representation may silently discard data held only by its competing row.
      blockedCount++
      continue
    }
    if (legacy.length === 0) {
      rows.push({ sourceKey: alias, meta: { ...meta, hostId: scope.hostId } })
    }
  }
  return { rows, blockedCount }
}

export function retireOrcadSourceWorktreeMetadata(
  state: PersistedState,
  manifest: OrcadMigrationManifest
) {
  const scope = createOrcadMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload
  })
  const entries = manifest.payload.dormantState?.worktreeMeta ?? []
  const worktreeIds = new Set(entries.map((entry) => entry.worktreeId))
  const removedIdentities = new Set<string>()
  for (const [alias, identities] of Object.entries(state.worktreeIdentityAliases ?? {})) {
    if (
      getExecutionHostIdFromWorktreeHostIdentity(alias) === scope.hostId &&
      worktreeIds.has(unqualifyOrcadMigrationOwnerKey(alias))
    ) {
      identities.forEach((identity) => removedIdentities.add(identity))
      delete state.worktreeIdentityAliases?.[alias]
    }
  }
  entries.forEach((entry) => delete state.worktreeMeta[entry.sourceKey])
  pruneUnreferencedWorktreeIdentityMeta(state, removedIdentities)
}

export function assertOrcadSourceWorktreeMetadataRetired(
  state: PersistedState,
  manifest: OrcadMigrationManifest
) {
  const scope = createOrcadMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload
  })
  const inspection = inspectOrcadSourceWorktreeMetadata(state, scope)
  if (inspection.rows.length || inspection.blockedCount) {
    throw new Error('orcad_migration_source_worktree_metadata_reappeared')
  }
}
