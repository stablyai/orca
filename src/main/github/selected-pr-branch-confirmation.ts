import type { getPRForBranch } from './client'

type PRLookup = ReturnType<typeof getPRForBranch>

/**
 * Second opinion for "does this branch own the selected PR?" when the
 * branch-name lookup came back empty.
 *
 * Why: branch lookup asks GitHub for a PR whose head is `{origin owner}:{branch}`,
 * and falls back to the branch's tracked upstream when that misses. During worktree
 * create the branch is the thing being named, so it has no tracked upstream and the
 * fallback cannot run — a clone whose `origin` is a fork therefore never matches a PR
 * opened from upstream or another fork (#16646). The sibling hosted-review path
 * already passes the selected number for exactly this reason.
 *
 * Comparing the head ref rather than the number keeps this a real check: fetching by
 * number makes the number match by construction, the head ref does not.
 */
export async function confirmsSelectedGitHubPrByNumber(args: {
  lookupByNumber: (linkedPRNumber: number) => PRLookup
  linkedPR: number | null | undefined
  branchNameOverride: string | undefined
  branchName: string
}): Promise<boolean> {
  if (typeof args.linkedPR !== 'number' || args.branchNameOverride !== args.branchName) {
    return false
  }
  let pr: Awaited<PRLookup> = null
  try {
    pr = await args.lookupByNumber(args.linkedPR)
  } catch {
    return false
  }
  return pr?.number === args.linkedPR && pr?.headRefName === args.branchName
}
