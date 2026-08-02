// Picks the authoritative PR number to resolve for the sidebar. The hosted-review
// branch hint (open reviews) wins; otherwise we fall back to the worktree's persisted
// linkedPR, which is how a CLOSED or MERGED linked PR still gets fetched and shown
// (desktop's linkedGitHubPR behavior). Pure + unit-tested.
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
