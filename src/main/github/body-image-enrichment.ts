import { githubBodyImageCandidates, githubBodyImageUrls } from './body-image-urls'
import { ghExecFileAsync } from './gh-utils'
import type { GitHubApiRepository, GitHubRepoExecOptions } from './github-api-repository'
import { extractExecError } from '../git/exec-error'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from './rate-limit'

export type GitHubBodyImageTarget = {
  nodeId?: string | null
  target: { body: string; bodyImageUrls?: Record<string, string> }
}

export function collectGitHubImageBody<T extends GitHubBodyImageTarget['target']>(
  targets: GitHubBodyImageTarget[],
  nodeId: string | null | undefined,
  target: T
): T {
  targets.push({ nodeId, target })
  return target
}

export const BODY_IMAGE_PAIRS_QUERY = `query PrivateImageBodyPairs($ids: [ID!]!) {
  nodes(ids: $ids) {
    id
    ... on Issue { body bodyHTML }
    ... on PullRequest { body bodyHTML }
    ... on IssueComment { body bodyHTML }
    ... on PullRequestReview { body bodyHTML }
    ... on PullRequestReviewComment { body bodyHTML }
  }
}`

// The owning read holds its semaphore; enrichment must never prevent returning its raw snapshot.
export async function enrichGitHubBodyImages(
  targets: GitHubBodyImageTarget[],
  repository: GitHubApiRepository,
  ghOptions: GitHubRepoExecOptions
): Promise<void> {
  const candidates = new Map<string, GitHubBodyImageTarget['target'][]>()
  for (const { nodeId, target } of targets) {
    if (!nodeId || !githubBodyImageCandidates(target.body).size) {
      continue
    }
    const existing = candidates.get(nodeId)
    if (existing) {
      existing.push(target)
    } else {
      candidates.set(nodeId, [target])
    }
  }
  const ids = [...candidates.keys()]
  for (let offset = 0; offset < ids.length; offset += 100) {
    if (repositoryRateLimitGuard(repository, 'graphql', ghOptions).blocked) {
      return
    }
    try {
      noteRepositoryRateLimitSpend(repository, 'graphql', 1, ghOptions)
      let stdout: string
      try {
        ;({ stdout } = await ghExecFileAsync(['api', 'graphql', '--input', '-'], {
          ...ghOptions,
          stdin: JSON.stringify({
            query: BODY_IMAGE_PAIRS_QUERY,
            variables: { ids: ids.slice(offset, offset + 100) }
          })
        }))
      } catch (error) {
        stdout = extractExecError(error).stdout
      }
      const result: unknown = JSON.parse(stdout)
      if (!result || typeof result !== 'object' || !('data' in result)) {
        continue
      }
      const data = result.data
      if (!data || typeof data !== 'object' || !('nodes' in data) || !Array.isArray(data.nodes)) {
        continue
      }
      for (const node of data.nodes) {
        if (
          !node ||
          typeof node.id !== 'string' ||
          typeof node.body !== 'string' ||
          typeof node.bodyHTML !== 'string'
        ) {
          continue
        }
        const matched = candidates.get(node.id)?.filter((target) => target.body === node.body)
        if (!matched?.length) {
          continue
        }
        const urls = githubBodyImageUrls(node.body, node.bodyHTML)
        for (const target of matched) {
          target.bodyImageUrls = urls
        }
      }
    } catch {
      // Missing or invalid optional HTML keeps the successfully fetched Markdown usable.
    }
  }
}
