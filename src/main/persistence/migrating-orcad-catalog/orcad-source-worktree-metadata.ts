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
    if (orcadMigrationOwnerMatchesScope(sourceKey, scope, meta.hostId)) {
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
    if (isDanglingAlias(state, identities) && orcadMigrationOwnerMatchesScope(alias, scope)) {
      continue // Names no metadata (its legacy row, if any, moves instead): nothing to move.
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

export function subtractOrcadSourceWorktreeMetadata(
  state: PersistedState,
  manifest: OrcadMigrationManifest
) {
  const scope = createOrcadMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload,
    repos: state.repos
  })
  const entries = manifest.payload.dormantState?.worktreeMeta ?? []
  // Rows a downgraded build added in a moved project go too: the server's copy of it wins.
  const added = inspectOrcadSourceWorktreeMetadata(state, scope).rows.map((row) => row.sourceKey)
  const sourceKeys = new Set([...entries.map((entry) => entry.sourceKey), ...added])
  const worktreeIds = new Set([
    ...entries.map((entry) => entry.worktreeId),
    ...added.map(unqualifyOrcadMigrationOwnerKey)
  ])
  const removedIdentities = new Set<string>()
  for (const [alias, identities] of Object.entries(state.worktreeIdentityAliases ?? {})) {
    if (
      getExecutionHostIdFromWorktreeHostIdentity(alias) === scope.hostId &&
      (worktreeIds.has(unqualifyOrcadMigrationOwnerKey(alias)) ||
        (isDanglingAlias(state, identities) && orcadMigrationOwnerMatchesScope(alias, scope)))
    ) {
      identities.forEach((identity) => removedIdentities.add(identity))
      delete state.worktreeIdentityAliases?.[alias]
    }
  }
  sourceKeys.forEach((sourceKey) => delete state.worktreeMeta[sourceKey])
  pruneUnreferencedWorktreeIdentityMeta(state, removedIdentities)
}

/** An alias whose identities hold no metadata, as a profile that lost them leaves behind. */
function isDanglingAlias(state: PersistedState, identities: readonly string[]): boolean {
  return identities.every((identity) => {
    const meta = state.worktreeMetaByIdentity?.[identity]
    return !meta || Object.keys(meta).length === 0
  })
}
