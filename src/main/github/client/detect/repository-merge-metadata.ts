import { normalizeGitHubPRMergeMethodSettings } from '../../../../shared/github/pull-request-merge-methods'
import { ghExecFileAsync } from '../../gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from '../../github-api-repository'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../rate-limit'
import type { GhExecOptions } from './../github-exec-scope'
import {
  MERGE_QUEUE_CACHE_TTL_MS,
  MERGE_QUEUE_UNKNOWN_CACHE_TTL_MS,
  repositoryMergeMetadataCache,
  pruneRepositoryMergeMetadataCache,
  cacheRepositoryMergeMetadata,
  type GitHubRepositoryMergeMetadata
} from './repository-merge-metadata-cache'
export async function detectRepositoryMergeMetadata(
  ownerRepo: GitHubApiRepository,
  branchName: string | undefined,
  ghOptions: GhExecOptions,
  executionScope: string | undefined = 'default'
): Promise<GitHubRepositoryMergeMetadata> {
  const cacheKey = `${executionScope ?? 'default'}\0${githubRepoIdentityKey(ownerRepo)}:${branchName ?? '__repo__'}`
  pruneRepositoryMergeMetadataCache()
  const cached = repositoryMergeMetadataCache.get(cacheKey)
  if (cached) {
    return cached.value
  }
  const guard = repositoryRateLimitGuard(ownerRepo, 'graphql', ghOptions)
  if (guard.blocked) {
    return { mergeQueueRequired: null, autoMergeAllowed: null }
  }
  const query = branchName
    ? `query($owner: String!, $repo: String!, $branch: String!, $qualified: String!) {
    repository(owner: $owner, name: $repo) {
      viewerDefaultMergeMethod
      mergeCommitAllowed
      rebaseMergeAllowed
      squashMergeAllowed
      autoMergeAllowed
      mergeQueue(branch: $branch) { id }
      ref(qualifiedName: $qualified) {
        rules(first: 50) { nodes { type } }
      }
    }
  }`
    : `query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      viewerDefaultMergeMethod
      mergeCommitAllowed
      rebaseMergeAllowed
      squashMergeAllowed
      autoMergeAllowed
    }
  }`
  try {
    noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `owner=${ownerRepo.owner}`,
      '-f',
      `repo=${ownerRepo.repo}`
    ]
    if (branchName) {
      args.push('-f', `branch=${branchName}`)
      args.push('-f', `qualified=refs/heads/${branchName}`)
    }
    const { stdout } = await ghExecFileAsync(args, {
      ...ghOptions,
      ...githubHostExecOptions(ownerRepo)
    })
    const parsed = JSON.parse(stdout) as {
      data?: {
        repository?: {
          viewerDefaultMergeMethod?: unknown
          mergeCommitAllowed?: unknown
          rebaseMergeAllowed?: unknown
          squashMergeAllowed?: unknown
          autoMergeAllowed?: unknown
          mergeQueue?: { id?: unknown } | null
          ref?: { rules?: { nodes?: ({ type?: unknown } | null)[] | null } | null } | null
        } | null
      }
    }
    const repository = parsed.data?.repository
    const mergeMethodSettings = repository
      ? normalizeGitHubPRMergeMethodSettings({
          defaultMethod: repository.viewerDefaultMergeMethod,
          mergeCommitAllowed: repository.mergeCommitAllowed,
          rebaseMergeAllowed: repository.rebaseMergeAllowed,
          squashMergeAllowed: repository.squashMergeAllowed
        })
      : undefined
    const value: GitHubRepositoryMergeMetadata = {
      mergeQueueRequired: branchName
        ? Boolean(repository?.mergeQueue) ||
          Boolean(repository?.ref?.rules?.nodes?.some((rule) => rule?.type === 'MERGE_QUEUE'))
        : null,
      autoMergeAllowed:
        typeof repository?.autoMergeAllowed === 'boolean' ? repository.autoMergeAllowed : null,
      ...(mergeMethodSettings ? { mergeMethodSettings } : {})
    }
    // Why: a payload without `repository` is all-unknown; keep it on the short TTL so it retries once the condition clears.
    cacheRepositoryMergeMetadata(
      cacheKey,
      value,
      repository ? MERGE_QUEUE_CACHE_TTL_MS : MERGE_QUEUE_UNKNOWN_CACHE_TTL_MS
    )
    return value
  } catch {
    // Why: cache a conservative result for failed merge-queue probes so we don't retry GraphQL on every poll while GitHub/network is unhappy.
    const value: GitHubRepositoryMergeMetadata = {
      mergeQueueRequired: null,
      autoMergeAllowed: null
    }
    cacheRepositoryMergeMetadata(cacheKey, value, MERGE_QUEUE_UNKNOWN_CACHE_TTL_MS)
    return value
  }
}
