import { composeWorktreeHostIdentity } from '../../../src/shared/worktree/host-qualified-identity'
import type { Worktree } from './workspace-list-types'

type WorktreeRowIdentitySource = Pick<Worktree, 'worktreeId' | 'hostId'>

export function getWorktreeRowIdentity(row: WorktreeRowIdentitySource): string {
  return composeWorktreeHostIdentity(row.hostId, row.worktreeId)
}

export function isSameWorktreeRow(
  a: WorktreeRowIdentitySource,
  b: WorktreeRowIdentitySource
): boolean {
  return getWorktreeRowIdentity(a) === getWorktreeRowIdentity(b)
}

/** Drops only the removed row, leaving a same-id workspace on another host visible. */
export function removeWorktreeRow(
  list: readonly Worktree[],
  removed: WorktreeRowIdentitySource
): Worktree[] {
  return list.filter((entry) => !isSameWorktreeRow(entry, removed))
}

export function clearConfirmedActiveWorktreeIdentity(
  pending: string | null,
  confirmed: readonly Worktree[]
): string | null {
  return pending && confirmed.some((w) => getWorktreeRowIdentity(w) === pending && w.isActive)
    ? null
    : pending
}

export function retainLiveSleptWorktreeIdentities(
  previous: Set<string>,
  confirmed: readonly Worktree[]
): Set<string> {
  if (previous.size === 0) {
    return previous
  }
  const confirmedByIdentity = new Map<string, Worktree>()
  for (const worktree of confirmed) {
    const identity = getWorktreeRowIdentity(worktree)
    // The former Array#find path was first-match-wins for duplicate identities; retain that contract.
    if (!confirmedByIdentity.has(identity)) {
      confirmedByIdentity.set(identity, worktree)
    }
  }
  const still = new Set<string>()
  for (const id of previous) {
    const wt = confirmedByIdentity.get(id)
    if (wt && wt.liveTerminalCount > 0) {
      still.add(id)
    }
  }
  return still.size === previous.size ? previous : still
}

export function applyWorktreeRowDisplayState(
  base: Worktree[],
  sleptIds: ReadonlySet<string>,
  optimisticActiveIdentity: string | null
): Worktree[] {
  if (sleptIds.size === 0 && optimisticActiveIdentity === null) {
    return base
  }
  return base.map((w) => {
    const slept = sleptIds.has(getWorktreeRowIdentity(w))
      ? { liveTerminalCount: 0, hasAttachedPty: false, status: 'inactive' as const }
      : null
    const active =
      optimisticActiveIdentity !== null
        ? { isActive: getWorktreeRowIdentity(w) === optimisticActiveIdentity }
        : null
    return slept || active ? { ...w, ...slept, ...active } : w
  })
}
