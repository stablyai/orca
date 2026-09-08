import type { GitHubApiRepositoryCandidates } from '../../github-api-repository'
import { lookupPRByBranchName } from './pr-branch-lookup'

type BranchLookupArgs = Parameters<typeof lookupPRByBranchName>[0]

export async function lookupPRByBranchEvidence(
  args: BranchLookupArgs & Pick<GitHubApiRepositoryCandidates, 'head' | 'unverifiableRemotes'>
): ReturnType<typeof lookupPRByBranchName> {
  const inconclusive = () => ({
    data: null,
    dataRepo: null,
    pendingError: new Error(
      'Could not resolve to a Repository: repository evidence does not establish the review branch owner.'
    )
  })
  // A branch-only positive cannot identify an owner any more than an empty list can.
  if (args.head && (args.head.kind !== 'resolved' || !args.headRepo)) {
    return inconclusive()
  }
  const result = await lookupPRByBranchName(args)
  // Full head identity corroborates positives; only tracked evidence establishes absence.
  if (
    !result.data &&
    !('pendingError' in result) &&
    (args.unverifiableRemotes?.length ||
      (args.head?.kind === 'resolved' && args.head.confidence === 'inferred'))
  ) {
    return inconclusive()
  }
  return result
}
