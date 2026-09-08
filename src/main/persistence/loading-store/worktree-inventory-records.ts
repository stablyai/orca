import {
  addPersistedSessionWorktreeOwners,
  getPersistedWorktreeOwnerId
} from '../restoring-sessions/session-worktree-ownership'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type {
  WorktreeInventoryRecord,
  WorktreeInventoryRecords
} from '../../../shared/worktree/inventory'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'

type InventoryState = Pick<
  PersistedState,
  | 'projects'
  | 'projectHostSetups'
  | 'worktreeMeta'
  | 'worktreeMetaByIdentity'
  | 'worktreeIdentityAliases'
  | 'worktreeLineageById'
  | 'workspaceLineageByChildKey'
  | 'workspaceSession'
  | 'workspaceSessionsByHostId'
>

/** Unlike display projections, this keeps competing aliases and unreferenced canonical rows. */
export function collectWorktreeInventoryRecords(
  state: InventoryState,
  repoId: string,
  hostId: ExecutionHostId
): WorktreeInventoryRecords {
  const records: WorktreeInventoryRecord[] = []
  const localIds = new Set<string>()
  const localInstances = new Set<string>()
  let ambiguous = false
  const belongs = (id: string) => id.startsWith(`${repoId}::`)
  const aliasesByIdentity = new Map<string, string[]>()
  const aliases = Object.entries(state.worktreeIdentityAliases ?? {})
  for (const [alias, keys] of aliases) {
    for (const key of keys) {
      const ids = aliasesByIdentity.get(key) ?? []
      ids.push(alias)
      aliasesByIdentity.set(key, ids)
    }
  }
  const identityTouchesHost = (key: string) =>
    key.startsWith(`wt2:${encodeURIComponent(hostId)}:`) ||
    state.worktreeMetaByIdentity?.[key]?.hostId === hostId
  const projectIds = new Set(
    (state.projects ?? [])
      .filter((project) => project.sourceRepoIds.includes(repoId))
      .map((project) => project.id)
  )
  const setupIds = new Set(
    (state.projectHostSetups ?? [])
      .filter((setup) => setup.repoId === repoId && setup.hostId === hostId)
      .map((setup) => setup.id)
  )
  const identityClaimsScope = (key: string) => {
    const meta = state.worktreeMetaByIdentity?.[key]
    return Boolean(
      meta &&
      ((meta.projectHostSetupId && setupIds.has(meta.projectHostSetupId)) ||
        (identityTouchesHost(key) && meta.projectId && projectIds.has(meta.projectId)))
    )
  }
  function add(
    source: WorktreeInventoryRecord['source'],
    sourceKey: string,
    ids: string[],
    meta?: Partial<WorktreeMeta>,
    identityKeys: string[] = []
  ) {
    if (meta?.hostId === hostId) {
      for (const id of ids) {
        localIds.add(id)
        if (meta.instanceId) {
          localInstances.add(JSON.stringify([id, meta.instanceId]))
        }
      }
    }
    const record: WorktreeInventoryRecord = {
      source,
      sourceKey,
      worktreeId: ids[0] ?? null,
      relatedWorktreeIds: [...ids],
      hostId: meta?.hostId ?? null,
      instanceId: meta?.instanceId ?? null,
      projectId: meta?.projectId ?? null,
      projectHostSetupId: meta?.projectHostSetupId ?? null,
      identityKeys: [...identityKeys]
    }
    records.push(record)
    return record
  }
  for (const [id, meta] of Object.entries(state.worktreeMeta)) {
    if (!belongs(id) || (meta.hostId && meta.hostId !== hostId)) {
      continue
    }
    add('legacy-metadata', id, [id], meta)
    if (!meta.hostId) {
      ambiguous = true
    }
  }
  for (const [alias, keys] of aliases) {
    const id = getWorktreeIdFromHostIdentity(alias)
    const owner = getExecutionHostIdFromWorktreeHostIdentity(alias)
    if (
      !keys.some(identityClaimsScope) &&
      (!belongs(id) || (owner && owner !== hostId && !keys.some(identityTouchesHost)))
    ) {
      continue
    }
    add('identity-alias', alias, [id], { hostId: owner }, keys)
    if (
      !belongs(id) ||
      owner !== hostId ||
      keys.length !== 1 ||
      keys.some((key) => !state.worktreeMetaByIdentity?.[key])
    ) {
      ambiguous = true
    }
  }
  for (const [key, meta] of Object.entries(state.worktreeMetaByIdentity ?? {})) {
    const references = aliasesByIdentity.get(key) ?? []
    const pertinent = references.filter(
      (alias) =>
        identityClaimsScope(key) ||
        (belongs(getWorktreeIdFromHostIdentity(alias)) &&
          (!getExecutionHostIdFromWorktreeHostIdentity(alias) ||
            getExecutionHostIdFromWorktreeHostIdentity(alias) === hostId ||
            identityTouchesHost(key)))
    )
    if (references.length > 0 && pertinent.length === 0) {
      continue
    }
    if (
      references.length === 0 &&
      meta.hostId &&
      meta.hostId !== hostId &&
      !identityTouchesHost(key) &&
      !identityClaimsScope(key)
    ) {
      continue
    }
    const ids = [...new Set(pertinent.map(getWorktreeIdFromHostIdentity))]
    add('canonical-metadata', key, ids, meta, [key])
    if (
      pertinent.some(
        (alias) =>
          !belongs(getWorktreeIdFromHostIdentity(alias)) ||
          getExecutionHostIdFromWorktreeHostIdentity(alias) !== hostId
      ) ||
      !meta.hostId ||
      meta.hostId !== hostId ||
      !meta.instanceId ||
      ids.length === 0 ||
      key !==
        canonicalWorktreeIdentity({
          worktreeId: ids[0] ?? '',
          executionHostId: hostId,
          instanceId: meta.instanceId
        })
    ) {
      ambiguous = true
    }
  }
  const hostForLineage = (id: string, instanceId?: string | null): Partial<WorktreeMeta> => {
    return {
      hostId: localInstances.has(JSON.stringify([id, instanceId])) ? hostId : undefined,
      instanceId: instanceId ?? undefined
    }
  }
  for (const [key, row] of Object.entries(state.worktreeLineageById)) {
    const ids = [...new Set([key, row.worktreeId, row.parentWorktreeId])].filter(belongs)
    if (ids.length === 0) {
      continue
    }
    const meta = hostForLineage(row.worktreeId, row.worktreeInstanceId)
    add('worktree-lineage', key, ids, meta).lineage = structuredClone(row)
    if (!meta.hostId) {
      ambiguous = true
    }
  }
  const worktreeId = (key: string) => {
    const scope = parseWorkspaceKey(key)
    return scope?.type === 'worktree' ? scope.worktreeId : null
  }
  for (const [key, row] of Object.entries(state.workspaceLineageByChildKey)) {
    const ids = [
      ...new Set([key, row.childWorkspaceKey, row.parentWorkspaceKey].map(worktreeId))
    ].filter((id): id is string => id !== null && belongs(id))
    if (ids.length === 0) {
      continue
    }
    const child = worktreeId(row.childWorkspaceKey)
    const meta = child ? hostForLineage(child, row.childInstanceId) : {}
    add('workspace-lineage', key, ids, meta).lineage = structuredClone(row)
    if (!meta.hostId) {
      ambiguous = true
    }
  }
  const partitions = [
    ['local', state.workspaceSession],
    ...Object.entries(state.workspaceSessionsByHostId ?? {})
  ] as const
  for (const [partition, session] of partitions) {
    if (!session) {
      continue
    }
    const seen = new Set<string>()
    addPersistedSessionWorktreeOwners(
      { workspaceSession: session },
      {
        owners: new Set(),
        addOwner: (ownerKey) => {
          if (!ownerKey || seen.has(ownerKey)) {
            return
          }
          seen.add(ownerKey)
          const id = getPersistedWorktreeOwnerId(ownerKey)
          if (!id || !belongs(id)) {
            return
          }
          const explicitHost = getExecutionHostIdFromWorktreeHostIdentity(ownerKey)
          if (
            (explicitHost && explicitHost !== hostId) ||
            (!explicitHost && partition !== hostId)
          ) {
            return
          }
          // Legacy local sessions can contain remote spill; the partition alone cannot assign ownership.
          const knownHost = localIds.has(id) ? hostId : undefined
          const owner = explicitHost ?? knownHost ?? undefined
          add('workspace-session', `${partition}|${ownerKey}`, [id], {
            hostId: owner
          }).partitionHostId = partition as ExecutionHostId
          if (!owner) {
            ambiguous = true
          }
        }
      }
    )
  }
  return { records, ambiguous }
}
