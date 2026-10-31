// Omit only identities their complete locator rows regenerate; older builds can remint the same keys on downgrade.
import { isDeepStrictEqual } from 'node:util'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../shared/worktree/host-qualified-identity'

export type WorktreeMetaAliasProjectionSource = Pick<
  PersistedState,
  'worktreeMeta' | 'worktreeIdentityAliases'
>

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Share reader/writer derivation; retained hostId/instanceId make default-field omission irrelevant. */
function identityKeyDerivedFromLocatorRow(alias: string, locatorRow: unknown): string | undefined {
  if (!isPlainRecord(locatorRow)) {
    return undefined
  }
  const { hostId, instanceId } = locatorRow as WorktreeMeta
  if (typeof hostId !== 'string' || !hostId || typeof instanceId !== 'string' || !instanceId) {
    return undefined
  }
  // Alias and locator host must agree or the derived key would replace another owner.
  if (getExecutionHostIdFromWorktreeHostIdentity(alias) !== hostId) {
    return undefined
  }
  return canonicalWorktreeIdentity({
    worktreeId: getWorktreeIdFromHostIdentity(alias),
    executionHostId: hostId,
    instanceId
  })
}

/** Exclude ambiguous aliases or multiply derived keys so reconstruction cannot depend on key ordering. */
function derivableIdentityRows(
  state: WorktreeMetaAliasProjectionSource
): Map<string, WorktreeMeta> {
  const derivable = new Map<string, WorktreeMeta>()
  const aliases = state.worktreeIdentityAliases
  const worktreeMeta = state.worktreeMeta as unknown
  if (!isPlainRecord(aliases) || !isPlainRecord(worktreeMeta)) {
    return derivable
  }
  const contested = new Set<string>()
  for (const [alias, identityKeys] of Object.entries(aliases)) {
    if (!Array.isArray(identityKeys) || identityKeys.length !== 1) {
      continue
    }
    const locatorRow = worktreeMeta[getWorktreeIdFromHostIdentity(alias)]
    const derivedKey = identityKeyDerivedFromLocatorRow(alias, locatorRow)
    if (derivedKey === undefined || derivedKey !== identityKeys[0]) {
      continue
    }
    if (derivable.has(derivedKey)) {
      contested.add(derivedKey)
      continue
    }
    derivable.set(derivedKey, locatorRow as WorktreeMeta)
  }
  for (const key of contested) {
    derivable.delete(key)
  }
  return derivable
}

/** Project before cloning/default omission to exploit shared-row reference equality. */
export function projectWorktreeMetaByIdentityOntoLocators(
  worktreeMetaByIdentity: Record<string, WorktreeMeta>,
  state: WorktreeMetaAliasProjectionSource
): Record<string, WorktreeMeta> {
  let projected: Record<string, WorktreeMeta> | undefined
  for (const [identityKey, locatorRow] of derivableIdentityRows(state)) {
    const identityRow = worktreeMetaByIdentity[identityKey]
    if (!isPlainRecord(identityRow)) {
      continue
    }
    if (identityRow !== locatorRow && !isDeepStrictEqual(identityRow, locatorRow)) {
      continue
    }
    projected ??= { ...worktreeMetaByIdentity }
    delete projected[identityKey]
  }
  return projected ?? worktreeMetaByIdentity
}

/** Rebuild before normalization drops dangling aliases; add only keys fully described by a locator row. */
export function hydrateWorktreeMetaAliasProjection(
  parsed: WorktreeMetaAliasProjectionSource & Pick<PersistedState, 'worktreeMetaByIdentity'>
): Record<string, WorktreeMeta> | undefined {
  const worktreeMetaByIdentity = parsed.worktreeMetaByIdentity
  if (!isPlainRecord(worktreeMetaByIdentity)) {
    return worktreeMetaByIdentity
  }
  for (const [identityKey, locatorRow] of derivableIdentityRows(parsed)) {
    if (Object.hasOwn(worktreeMetaByIdentity, identityKey)) {
      continue
    }
    // Restore the shared object reference used by in-session writes.
    worktreeMetaByIdentity[identityKey] = locatorRow
  }
  return worktreeMetaByIdentity
}
