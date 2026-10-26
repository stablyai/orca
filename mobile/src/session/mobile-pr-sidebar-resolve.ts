// Prefer the branch’s open review; persisted linkedPR still resolves closed/merged reviews.
export function resolveLinkedPrNumber(
  branchHint: number | null | undefined,
  worktreeLinkedPR: number | null | undefined
): number | null {
  if (typeof branchHint === 'number') {
    return branchHint
  }
  if (typeof worktreeLinkedPR === 'number') {
    return worktreeLinkedPR
  }
  return null
}
