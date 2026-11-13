import { z } from 'zod'
import type { CommunityGitHubSource } from './community-github-source'
import type { CommunityPublishedData } from './community-published-data'
import type { CommunityFeatureStore } from './community-feature-store'
import type { CommunityReleaseProof } from '../../shared/community-features'
const sha = z.string().regex(/^[a-f0-9]{40}$/)
export async function verifyCommunityRelease(
  number: number,
  source: CommunityGitHubSource,
  published: CommunityPublishedData,
  features: CommunityFeatureStore
): Promise<CommunityReleaseProof> {
  const signal = new AbortController().signal
  const pr = z
    .object({
      merged_at: z.string().nullable(),
      merge_commit_sha: sha.nullable(),
      head: z.object({ sha })
    })
    .parse(await source.request(`pulls/${number}`, signal))
  if (!pr.merged_at || !pr.merge_commit_sha) {
    throw new Error('This PR has no verified merge commit yet.')
  }
  const releases = (await published.releases()).filter(
    (release) => !release.prerelease && release.publishedAt >= pr.merged_at!
  )
  if (!releases.length) {
    throw new Error(
      'No captured official release was published after this merge. Refresh the changelog later.'
    )
  }
  for (const release of releases.slice(0, 5)) {
    const commit = z
      .object({ sha })
      .parse(await source.request(`commits/${encodeURIComponent(release.tag)}`, signal))
    const comparison = z
      .object({ status: z.enum(['ahead', 'behind', 'identical', 'diverged']) })
      .parse(await source.request(`compare/${pr.merge_commit_sha}...${commit.sha}`, signal))
    if (comparison.status !== 'ahead' && comparison.status !== 'identical') {
      continue
    }
    const proof = {
      headSha: pr.head.sha,
      tag: release.tag,
      releaseCommit: commit.sha,
      mergeCommit: pr.merge_commit_sha,
      url: release.url,
      comparisonUrl: `https://github.com/stablyai/orca/compare/${pr.merge_commit_sha}...${commit.sha}`,
      observedAt: new Date().toISOString()
    }
    await features.recordRelease(number, proof)
    return proof
  }
  throw new Error('The five latest eligible official releases do not contain this merge commit.')
}
