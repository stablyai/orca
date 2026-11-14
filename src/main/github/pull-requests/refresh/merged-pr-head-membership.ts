import type { GitHubRepositoryIdentity as OwnerRepo } from '../../../../shared/github/repositories/repository-identity'
import type { GitHubRepoExecOptions } from '../../repositories/github-api-repository'
import type { HostedReviewLocalGitOptions } from '../../../source-control/hosted-review-git-options'
import {
  getMergedPRHeadRelationship,
  type MergedPRHeadRelationship
} from './merged-pr-commit-membership'
import { mergedReviewHeadIsEquivalent } from '../../../source-control/merged-review-head-equivalence'

/** Membership or local equivalence proves containment; force-push history alone stays associated. */
export async function mergedPRHeadMembership(args: {
  ownerRepo: OwnerRepo
  prNumber: number
  prHeadOid: string | undefined
  baseRefName: string | undefined
  headOid: string
  ghOptions: GitHubRepoExecOptions
  repoPath: string
  connectionId?: string | null
  localGitOptions: HostedReviewLocalGitOptions
}): Promise<MergedPRHeadRelationship> {
  const membership = await getMergedPRHeadRelationship({
    ownerRepo: args.ownerRepo,
    prNumber: args.prNumber,
    commitOid: args.headOid,
    ghOptions: args.ghOptions
  })
  if (membership === 'contained') {
    return membership
  }
  const equivalent = await mergedReviewHeadIsEquivalent({
    repoPath: args.repoPath,
    connectionId: args.connectionId,
    localGitOptions: args.localGitOptions,
    reviewHeadOid: args.prHeadOid,
    baseBranchName: args.baseRefName,
    headOid: args.headOid
  })
  return equivalent ? 'contained' : membership
}

export function createMergedPRHeadMembershipResolver() {
  const cache = new Map<string, Promise<MergedPRHeadRelationship>>()
  return (args: Parameters<typeof mergedPRHeadMembership>[0]) => {
    const key = JSON.stringify([
      args.ownerRepo,
      args.prNumber,
      args.prHeadOid,
      args.baseRefName,
      args.headOid
    ])
    let proof = cache.get(key)
    if (!proof) {
      proof = mergedPRHeadMembership(args)
      cache.set(key, proof)
    }
    return proof
  }
}
