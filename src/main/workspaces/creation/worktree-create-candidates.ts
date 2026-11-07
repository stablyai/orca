import { getGeneratedWorktreeCreateRetryCandidate } from '../../../shared/new-workspace/worktree-create-retry-policy'

export const WORKTREE_CREATE_MAX_SUFFIX_ATTEMPTS = 100

export function getWorktreeCreateCandidate(value: string, suffix: number): string {
  return suffix === 1 ? value : `${value}-${suffix}`
}

/**
 * Starts above the highest existing numeric suffix so probing never re-enters a range known to be taken.
 * The gate reads branch names (they carry the configured prefix and the .lock rewrite); the count reads
 * candidate names, because the folder never carries the prefix and can collide with an unprefixed sibling.
 */
export function getWorktreeCreateStartingSuffix(args: {
  baseName: string
  branchBaseName: string
  existingBranchNames: readonly string[]
  existingCandidateNames: readonly string[]
}): number {
  if (!args.existingBranchNames.includes(args.branchBaseName)) {
    return 1
  }
  const suffixPrefix = `${args.baseName}-`
  let highest = 0
  for (const existing of args.existingCandidateNames) {
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
