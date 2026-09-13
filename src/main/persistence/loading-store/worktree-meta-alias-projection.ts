/**
 * `setWorktreeMetaForHost` stores one object in both `worktreeMeta` and `worktreeMetaByIdentity`,
 * so the profile serializes every metadata row twice. On a measured 3.64 MB install, 1,347 of
 * 1,349 locator rows were byte-identical to their identity twin: 540 KB of identity rows
 * re-serialized on every debounced save and re-parsed on every launch.
 *
 * The identity row is the copy that is dropped, never the locator row, and only when the locator
 * row *regenerates its own key*: `wt2:<hostId>:<instanceId>` is a pure function of two fields the
 * locator row still carries. That direction is what makes the change free of a format marker.
 * "Alias present, identity row absent, locator row derives the key" is not a state any build ever
 * writes deliberately -- `pruneUnreferencedWorktreeIdentityMeta` only drops rows whose alias is
 * already gone, and `normalizeWorktreeLinkedItemMetadata` only drops aliases whose row is already
 * gone -- and it is a state every build since #16691 already heals, to exactly the row this
 * rebuild produces, via `migrateLegacyWorktreeMetadata`. So a downgrade is lossless by
 * construction: the old build sees a complete `worktreeMeta`, drops the dangling aliases, and
 * re-mints the identical identity key from the row's preserved `instanceId` on first read.
 *
 * The rebuild also reinstates the shared object reference that `JSON.parse` splits in two.
 */
import { isDeepStrictEqual } from 'node:util'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../shared/worktree/host-qualified-identity'

/** Every slice of a parsed profile file the projection reads; `PersistedState` satisfies it. */
export type WorktreeMetaAliasProjectionSource = Pick<
  PersistedState,
  'worktreeMeta' | 'worktreeIdentityAliases'
>

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The identity key an alias' own locator row regenerates, or undefined when it does not.
 *
 * The single definition of the omission rule: writer and reader both go through it, so they cannot
 * disagree about which key is derivable. `hostId` and `instanceId` are not in
 * `WORKTREE_META_PERSISTED_DEFAULTS`, so the answer is the same before and after default omission.
 */
function identityKeyDerivedFromLocatorRow(alias: string, locatorRow: unknown): string | undefined {
  if (!isPlainRecord(locatorRow)) {
    return undefined
  }
  const { hostId, instanceId } = locatorRow as WorktreeMeta
  if (typeof hostId !== 'string' || !hostId || typeof instanceId !== 'string' || !instanceId) {
    return undefined
  }
  // The alias must name the same host, or the key the reader derives is not the key it replaces.
  if (getExecutionHostIdFromWorktreeHostIdentity(alias) !== hostId) {
    return undefined
  }
  return canonicalWorktreeIdentity({
    worktreeId: getWorktreeIdFromHostIdentity(alias),
    executionHostId: hostId,
    instanceId
  })
}

/**
 * Identity key -> the locator row that regenerates it, for every alias that does so unambiguously.
 *
 * A key two aliases both derive is left out entirely: which locator row would rebuild it would
 * then depend on object key order, which is not a durable contract across a JSON round trip. An
 * alias carrying more than one key is left out too -- `setWorktreeMetaForHost` refuses to write
 * one, so it is a repair state, and only one of its rows could ever be derivable anyway.
 */
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

/**
 * Serialize side, on the raw in-memory maps: an untouched row is the same object in both, so the
 * common case settles on a reference check and never a deep compare.
 */
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

/**
 * Load side, in place. Runs before the metadata normalizers, because
 * `normalizeWorktreeLinkedItemMetadata` drops an alias whose identity row is not there yet.
 *
 * Only ever adds a key the locator row already fully describes, so an untouched legacy file is a
 * no-op on it (nothing is missing) and a garbled one loses no more than it does today.
 */
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
    // Same reference in both maps, as every in-session write leaves it.
    worktreeMetaByIdentity[identityKey] = locatorRow
  }
  return worktreeMetaByIdentity
}
