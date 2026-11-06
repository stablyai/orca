import { getGeneratedWorktreeCreateRetryCandidate } from '../../../shared/new-workspace/worktree-create-retry-policy'

export const WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS = 100

export function getWorktreeCreateCandidate(value: string, suffix: number): string {
  return suffix === 1 ? value : `${value}-${suffix}`
}

/** Starts above the highest existing numeric suffix so probing never re-enters a range known to be taken. */
export function getWorktreeCreateStartingSuffix(
  baseName: string,
  existingNames: readonly string[],
  branchBaseName = baseName
): number {
  // Git rewrites a trailing .lock on the branch only, so the base can be taken under either name.
  if (!existingNames.includes(baseName) && !existingNames.includes(branchBaseName)) {
    return 1
  }
  const suffixPrefix = `${baseName}-`
  let highest = 0
  for (const existing of existingNames) {
    if (!existing.startsWith(suffixPrefix)) {
      continue
    }
    const suffix = existing.slice(suffixPrefix.length)
    if (!/^\d+$/.test(suffix)) {
      continue
    }
    highest = Math.max(highest, Number(suffix))
  }
  return highest + 1
}

export function getGeneratedWorktreeCreateCandidate(
  value: string,
  suffix: number,
  exhaustedTiers = 0
): string {
  return getGeneratedWorktreeCreateRetryCandidate(value, suffix - 1, exhaustedTiers + 1)
}

export function getBranchNameOverrideCandidate(
  branchNameOverride: string | undefined,
  suffix: number
): string | undefined {
  return branchNameOverride ? getWorktreeCreateCandidate(branchNameOverride, suffix) : undefined
}
