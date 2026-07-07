export const WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS = 100

export function getWorktreeCreateCandidate(value: string, suffix: number): string {
  return suffix === 1 ? value : `${value}-${suffix}`
}

export function getBranchNameOverrideCandidate(
  branchNameOverride: string | undefined,
  suffix: number
): string | undefined {
  return branchNameOverride ? getWorktreeCreateCandidate(branchNameOverride, suffix) : undefined
}
