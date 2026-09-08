import type { OwnerRepo } from '../../gh-utils'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { ownerRepoFromPullRequestUrl } from '../github-exec-scope'

export type PullRequestHeadIdentity =
  | { kind: 'resolved'; repository: OwnerRepo; branchName: string }
  | { kind: 'unverifiable'; reason: 'missing' | 'deleted' }

export type PullRequestHeadRepository = {
  name?: string
  nameWithOwner?: string
  full_name?: string
  owner?: { login?: string }
  html_url?: string
}

export type PullRequestHeadFields = {
  url: string
  headRefName?: string
  headRepository?: PullRequestHeadRepository | null
  headRepositoryOwner?: { login?: string } | null
}

export function readPullRequestHeadIdentity(
  data: PullRequestHeadFields,
  apiRepository?: OwnerRepo
): PullRequestHeadIdentity {
  const missing: PullRequestHeadIdentity = { kind: 'unverifiable', reason: 'missing' }
  const repo = data.headRepository
  if (repo === null) {
    return { kind: 'unverifiable', reason: 'deleted' }
  }
  if (!repo || !data.headRefName) {
    return missing
  }
  const slug = (repo.nameWithOwner ?? repo.full_name)?.split('/')
  const owner = data.headRepositoryOwner?.login ?? repo.owner?.login ?? slug?.[0]
  const name = repo.name ?? slug?.[1]
  if (!owner || !name || owner.includes('/') || name.includes('/')) {
    return missing
  }
  if (
    slug &&
    (slug.length !== 2 ||
      slug[0].toLowerCase() !== owner.toLowerCase() ||
      slug[1].toLowerCase() !== name.toLowerCase())
  ) {
    return missing
  }
  // A fork belongs to the queried forge, never to an inferred local remote.
  let host = apiRepository
    ? (apiRepository.host ?? 'github.com')
    : ownerRepoFromPullRequestUrl(data.url)?.host
  if (repo.html_url) {
    try {
      const url = new URL(repo.html_url)
      const path = url.pathname.replace(/\/$/, '').split('/')
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        path.length !== 3 ||
        path[1].toLowerCase() !== owner.toLowerCase() ||
        path[2].toLowerCase() !== name.toLowerCase()
      ) {
        return missing
      }
      host = url.host
    } catch {
      return missing
    }
  }
  return host
    ? { kind: 'resolved', repository: { owner, repo: name, host }, branchName: data.headRefName }
    : missing
}

export function matchesPullRequestHead(
  actual: PullRequestHeadIdentity | undefined,
  expectedRepository: OwnerRepo,
  expectedBranch: string
): boolean {
  return (
    actual?.kind === 'resolved' &&
    actual.branchName === expectedBranch &&
    githubRepoIdentityKey(actual.repository) === githubRepoIdentityKey(expectedRepository)
  )
}
