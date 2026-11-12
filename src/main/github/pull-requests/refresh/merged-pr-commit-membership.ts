import { z } from 'zod'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import { codeHostReadExecutionScope as githubReadExecutionScope } from '../../../source-control/code-host-read-execution-scope'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../api/rate-limit'
import { githubHostExecOptions } from '../../repositories/github-repository-host'
import { githubRepoIdentityKey } from '../../../../shared/github/repositories/repository-identity-key'
import type { GitHubRepoExecOptions } from '../../repositories/github-api-repository'
import {
  type MergedReviewCommitMembership as MergedPRCommitMembership,
  MergedReviewMembershipMemo
} from '../../../source-control/merged-review-membership-memo'
import type { GitHubRepositoryIdentity as OwnerRepo } from '../../../../shared/github/repositories/repository-identity'

const COMMIT_PULLS_PAGE_SIZE = 100
const COMMIT_PULLS_MAX_PAGES = 5
export type MergedPRHeadRelationship = MergedPRCommitMembership | 'associated'
const membershipMemo = new MergedReviewMembershipMemo<MergedPRHeadRelationship>()

export function resetMergedPRCommitMembershipCacheForTest(): void {
  membershipMemo.clear()
}

/** Force-push history proves association only; it cannot prove those changes landed. */
export async function getMergedPRHeadRelationship(args: {
  ownerRepo: OwnerRepo
  prNumber: number
  commitOid: string
  ghOptions: GitHubRepoExecOptions
}): Promise<MergedPRHeadRelationship> {
  const oid = args.commitOid.trim().toLowerCase()
  if (!/^[0-9a-f]{4,64}$/.test(oid) || !Number.isInteger(args.prNumber)) {
    return 'unknown'
  }
  const owner = args.ownerRepo.owner
  const repo = args.ownerRepo.repo
  const ghOptions = { ...args.ghOptions, ...githubHostExecOptions(args.ownerRepo) }
  const cacheKey = `${githubReadExecutionScope(ghOptions)}\0${githubRepoIdentityKey(args.ownerRepo)}#${args.prNumber}@${oid}`
  const cached = membershipMemo.peek(cacheKey)
  if (cached !== undefined) {
    return cached
  }
  // An unrun probe cannot justify clearing a durable linked PR.
  if (repositoryRateLimitGuard(args.ownerRepo, 'core', ghOptions).blocked) {
    return 'unknown'
  }
  return membershipMemo.read(cacheKey, async () => {
    try {
      // Paginate until found or a short page proves absence; a full final page leaves membership unknown.
      for (let page = 1; page <= COMMIT_PULLS_MAX_PAGES; page += 1) {
        if (page > 1 && repositoryRateLimitGuard(args.ownerRepo, 'core', ghOptions).blocked) {
          return 'unknown'
        }
        noteRepositoryRateLimitSpend(args.ownerRepo, 'core', 1, ghOptions)
        const { stdout } = await ghExecFileAsync(
          [
            'api',
            `repos/${owner}/${repo}/commits/${oid}/pulls?per_page=${COMMIT_PULLS_PAGE_SIZE}&page=${page}`
          ],
          ghOptions
        )
        const parsed = JSON.parse(stdout) as unknown
        // Non-array success is unverified, not evidence that a durable link should be cleared.
        if (!Array.isArray(parsed)) {
          return 'unknown'
        }
        const entries = parsed
        const contained = entries.some(
          (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            (entry as { number?: unknown }).number === args.prNumber
        )
        if (contained) {
          return 'contained'
        }
        if (entries.length < COMMIT_PULLS_PAGE_SIZE) {
          return await wasForcePushedAwayFromPR(args.ownerRepo, args.prNumber, oid, ghOptions)
        }
      }
      return 'unknown'
    } catch {
      // A local commit can become queryable after push; preserve links until verification succeeds.
      return 'unknown'
    }
  })
}

const FORCE_PUSH_EVENTS_LIMIT = 100

const forcePushTimelineSchema = z.object({
  data: z.object({
    repository: z
      .object({
        pullRequest: z
          .object({
            timelineItems: z.object({
              totalCount: z.number(),
              nodes: z.array(
                z.object({ beforeCommit: z.object({ oid: z.string() }).nullish() }).nullable()
              )
            })
          })
          .nullable()
      })
      .nullable()
  })
})

// A rebase pushed from another checkout drops this commit's PR association; the PR's force-push
// history still names it, so the checkout provably held this PR's head.
async function wasForcePushedAwayFromPR(
  ownerRepo: OwnerRepo,
  prNumber: number,
  oid: string,
  ghOptions: GitHubRepoExecOptions
): Promise<MergedPRHeadRelationship> {
  if (repositoryRateLimitGuard(ownerRepo, 'graphql', ghOptions).blocked) {
    return 'unknown'
  }
  noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
  const { stdout } = await ghExecFileAsync(
    [
      'api',
      'graphql',
      '-f',
      `query=query($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT], last: ${FORCE_PUSH_EVENTS_LIMIT}) { totalCount nodes { ... on HeadRefForcePushedEvent { beforeCommit { oid } } } } } } }`,
      '-f',
      `owner=${ownerRepo.owner}`,
      '-f',
      `repo=${ownerRepo.repo}`,
      '-F',
      `number=${prNumber}`
    ],
    ghOptions
  )
  const parsed = forcePushTimelineSchema.safeParse(JSON.parse(stdout))
  const timeline = parsed.success ? parsed.data.data.repository?.pullRequest?.timelineItems : null
  if (!timeline) {
    return 'unknown'
  }
  if (timeline.nodes.some((node) => node?.beforeCommit?.oid.toLowerCase() === oid)) {
    return 'associated'
  }
  return timeline.totalCount > timeline.nodes.length ||
    timeline.nodes.some((node) => !node?.beforeCommit?.oid)
    ? 'unknown'
    : 'not-contained'
}
