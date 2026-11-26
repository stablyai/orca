import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'

type WorktreeMetaState = Pick<
  PersistedState,
  'worktreeMeta' | 'worktreeMetaByIdentity' | 'worktreeIdentityAliases'
>

export function resolveAliasIdentityKey(
  state: WorktreeMetaState,
  alias: string
): string | undefined {
  const identityKeys = state.worktreeIdentityAliases?.[alias] ?? []
  if (identityKeys.length === 0) {
    return undefined
  }
  const resolvable = identityKeys.filter((key) => state.worktreeMetaByIdentity?.[key])
  const candidates = resolvable.length > 0 ? resolvable : identityKeys
  // Deterministic tie-breaking keeps hosts consistent: newest activity, then greatest key.
  const winner = candidates.reduce((best, key) => {
    const bestTouch = state.worktreeMetaByIdentity?.[best]?.lastActivityAt ?? 0
    const keyTouch = state.worktreeMetaByIdentity?.[key]?.lastActivityAt ?? 0
    if (keyTouch !== bestTouch) {
      return keyTouch > bestTouch ? key : best
    }
    return key > best ? key : best
  })
  return winner
}
