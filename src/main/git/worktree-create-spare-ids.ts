import {
  isWorktreeCreatePreparation,
  parseWorktreePreparationId
} from '../../shared/worktree/create-preparation'

// Spares this process owns, by `<pid>-<uuid>` id. Listings hide them before Git records the lock
// (and on Git 2.25-2.30, whose listing has no lock reason), and the startup sweep never touches one.
const ownedSpareIds = new Set<string>()

/** Call before the spare's first git spawn. */
export function addOwnedSpareId(id: string): void {
  ownedSpareIds.add(id)
}

/** Call once the spare's discard succeeded or its handover settled. */
export function releaseOwnedSpareId(id: string): void {
  ownedSpareIds.delete(id)
}

export function isOwnedSpareId(id: string | null | undefined): boolean {
  return id ? ownedSpareIds.has(id) : false
}

/**
 * Listings hide a spare by Orca's lock reason, or by an id this process owns: that also covers the
 * moment between `worktree add` and `worktree lock`, and Git 2.25-2.30, which list no lock reason.
 */
export function isHiddenCreatePreparation(worktree: {
  path: string
  lockReason?: string
}): boolean {
  return (
    isWorktreeCreatePreparation(worktree) || isOwnedSpareId(parseWorktreePreparationId(worktree))
  )
}

export function _resetOwnedSpareIdsForTests(): void {
  ownedSpareIds.clear()
}
