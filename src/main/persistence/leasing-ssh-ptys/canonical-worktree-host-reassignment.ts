import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import {
  composeWorktreeHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../shared/worktree/host-qualified-identity'

type IdentityMove = {
  sourceKey: string
  nextKey: string
  instanceId: string
  sourceMeta: WorktreeMeta
  nextMeta: WorktreeMeta
}

type AliasMove = {
  oldAlias: string
  nextAlias: string
  identities: IdentityMove[]
}

/** Move canonical aliases only after every destination occupant is proven compatible. */
export function reassignCanonicalWorktreeMetadataHost(
  state: PersistedState,
  oldHostId: ExecutionHostId,
  newHostId: ExecutionHostId
): { changed: boolean; preservedWorktreeIds: ReadonlySet<string> } {
  const aliases = state.worktreeIdentityAliases ?? {}
  const identityMeta = state.worktreeMetaByIdentity ?? {}
  const repairedInstanceIds = new Map<string, string>()
  const plans: AliasMove[] = []

  for (const [oldAlias, rawKeys] of Object.entries(aliases)) {
    if (getExecutionHostIdFromWorktreeHostIdentity(oldAlias) !== oldHostId) {
      continue
    }
    const worktreeId = getWorktreeIdFromHostIdentity(oldAlias)
    if (!worktreeId || rawKeys.length === 0) {
      continue
    }
    const identities: IdentityMove[] = []
    let safe = true
    for (const sourceKey of new Set(rawKeys)) {
      const sourceMeta = identityMeta[sourceKey]
      if (!sourceMeta) {
        safe = false
        break
      }
      let instanceId = sourceMeta.instanceId ?? repairedInstanceIds.get(sourceKey)
      if (instanceId === undefined) {
        instanceId = randomUUID()
        repairedInstanceIds.set(sourceKey, instanceId)
      }
      const nextKey = canonicalWorktreeIdentity({
        worktreeId,
        executionHostId: newHostId,
        instanceId
      })
      const nextMeta = { ...sourceMeta, instanceId, hostId: newHostId }
      const duplicate = identities.find((identity) => identity.nextKey === nextKey)
      if (duplicate && !isDeepStrictEqual(duplicate.nextMeta, nextMeta)) {
        safe = false
        break
      }
      if (!duplicate) {
        identities.push({ sourceKey, nextKey, instanceId, sourceMeta, nextMeta })
      }
    }
    if (!safe) {
      continue
    }

    const nextAlias = composeWorktreeHostIdentity(newHostId, worktreeId)
    const candidateKeys = new Set(identities.map((identity) => identity.nextKey))
    if ((aliases[nextAlias] ?? []).some((key) => !candidateKeys.has(key))) {
      continue
    }
    if (
      identities.some((identity) => {
        const existing = identityMeta[identity.nextKey]
        return existing !== undefined && !isDeepStrictEqual(existing, identity.nextMeta)
      })
    ) {
      continue
    }
    plans.push({ oldAlias, nextAlias, identities })
  }

  if (plans.length > 0) {
    state.worktreeIdentityAliases ??= {}
    state.worktreeMetaByIdentity ??= {}
    for (const plan of plans) {
      for (const identity of plan.identities) {
        identity.sourceMeta.instanceId ??= identity.instanceId
        state.worktreeMetaByIdentity[identity.nextKey] ??= identity.nextMeta
      }
      state.worktreeIdentityAliases[plan.nextAlias] = [
        ...new Set([
          ...(state.worktreeIdentityAliases[plan.nextAlias] ?? []),
          ...plan.identities.map((identity) => identity.nextKey)
        ])
      ]
      delete state.worktreeIdentityAliases[plan.oldAlias]
    }

    const referenced = new Set(Object.values(state.worktreeIdentityAliases).flat())
    for (const sourceKey of new Set(
      plans.flatMap((plan) => plan.identities.map((identity) => identity.sourceKey))
    )) {
      if (!referenced.has(sourceKey)) {
        delete state.worktreeMetaByIdentity[sourceKey]
      }
    }
  }

  const preservedWorktreeIds = new Set<string>()
  for (const alias of Object.keys(state.worktreeIdentityAliases ?? {})) {
    if (getExecutionHostIdFromWorktreeHostIdentity(alias) === oldHostId) {
      preservedWorktreeIds.add(getWorktreeIdFromHostIdentity(alias))
    }
  }
  return { changed: plans.length > 0, preservedWorktreeIds }
}
