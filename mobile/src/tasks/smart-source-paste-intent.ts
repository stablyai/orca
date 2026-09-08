import type { GitHubWorkItem } from '../../../src/shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../src/shared/gitlab-types'
import {
  normalizeGitHubLinkQuery,
  parseGitHubIssueOrPRLink,
  type GitHubIssueOrPRLink,
  type RepoSlug
} from '../../../src/shared/new-workspace/github-links'
import { parseGitLabIssueOrMRLink } from '../../../src/shared/new-workspace/gitlab-links'
import { isSmartWorkspaceSourceQueryWithinLimit } from '../../../src/shared/new-workspace/smart-workspace-source-results'
import type { HostWorkspaceCreationOperations } from '../worktree/host-workspace-creation-operations'
import { githubRepoIdentityKey } from '../../../src/shared/github/repository-identity-key'

// A repo the picker can switch to for a cross-repo GitHub paste. Slug is derived
// best-effort from the repo's remote metadata.
export type PasteRepoCandidate = {
  id: string
  displayName: string
  slug: RepoSlug | null
}

export type GitHubPasteIntent =
  | { kind: 'github-link'; link: GitHubIssueOrPRLink }
  | { kind: 'github-number'; number: number }

export type GitLabPasteIntent = {
  kind: 'gitlab-link'
  link: NonNullable<ReturnType<typeof parseGitLabIssueOrMRLink>>
}

export type PasteIntent = GitHubPasteIntent | GitLabPasteIntent | null

// Pure: classify pasted text into a work-item lookup intent. A slug-bearing
// GitHub URL becomes 'github-link'; a bare "#123"/number becomes 'github-number';
// a GitLab issue/MR URL becomes 'gitlab-link'.
export function resolvePasteIntent(query: string): PasteIntent {
  if (!isSmartWorkspaceSourceQueryWithinLimit(query)) {
    return null
  }
  const trimmed = query.trim()
  if (!trimmed) {
    return null
  }
  const ghLink = parseGitHubIssueOrPRLink(trimmed)
  if (ghLink) {
    return { kind: 'github-link', link: ghLink }
  }
  const normalizedGh = normalizeGitHubLinkQuery(trimmed)
  if (normalizedGh.directNumber !== null && !/^https?:\/\//i.test(trimmed)) {
    return { kind: 'github-number', number: normalizedGh.directNumber }
  }
  const glLink = parseGitLabIssueOrMRLink(trimmed)
  if (glLink) {
    return { kind: 'gitlab-link', link: glLink }
  }
  return null
}

// Pure: derive an owner/repo slug from a repo's remote metadata so a pasted
// cross-repo URL can be matched to a locally known repo.
export function deriveRepoSlug(repo: {
  upstream?: { owner: string; repo: string; host?: string } | null
  gitRemoteIdentity?: { remoteUrl?: string; canonicalKey?: string } | null
}): RepoSlug | null {
  if (repo.upstream?.owner && repo.upstream.repo) {
    return {
      owner: repo.upstream.owner,
      repo: repo.upstream.repo,
      ...(repo.upstream.host ? { host: repo.upstream.host } : {})
    }
  }
  const source = repo.gitRemoteIdentity?.remoteUrl ?? repo.gitRemoteIdentity?.canonicalKey ?? ''
  const match = /(?:github\.com[/:]|^)([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/i.exec(source)
  if (match) {
    return { owner: match[1], repo: match[2] }
  }
  return null
}

function slugsEqual(a: RepoSlug | null, b: RepoSlug | null): boolean {
  if (!a || !b) {
    return false
  }
  return githubRepoIdentityKey(a) === githubRepoIdentityKey(b)
}

export function findRepoMatchingSlug(
  repos: readonly PasteRepoCandidate[],
  slug: RepoSlug
): PasteRepoCandidate | null {
  return repos.find((repo) => slugsEqual(repo.slug, slug)) ?? null
}

export async function findRepoMatchingSlugForPaste(
  operations: HostWorkspaceCreationOperations,
  repos: readonly PasteRepoCandidate[],
  slug: RepoSlug,
  cache: Map<string, RepoSlug | null>
): Promise<PasteRepoCandidate | null> {
  const projected = findRepoMatchingSlug(repos, slug)
  if (projected) {
    return projected
  }
  // Why: projected remote metadata is incomplete for SSH and GitHub Enterprise;
  // ask each repo's owning runtime instead of assuming github.com URL syntax.
  for (const repo of repos) {
    let resolved = cache.get(repo.id)
    if (!cache.has(repo.id)) {
      try {
        const result = await operations.resolveGitHubRepoSlug(repo.id)
        if (!result.supported) {
          // Why: RPC availability is host-wide; avoid repeating an unsupported
          // probe for every repo or on the next paste attempt.
          repos.forEach((candidate) => cache.set(candidate.id, null))
          return null
        }
        resolved = result.slug
      } catch {
        resolved = null
      }
      cache.set(repo.id, resolved ?? null)
    }
    if (slugsEqual(resolved ?? null, slug)) {
      return repo
    }
  }
  return null
}

export async function lookupGitHubItemByNumber(
  operations: HostWorkspaceCreationOperations,
  repoId: string,
  number: number
): Promise<GitHubWorkItem | null> {
  return operations.lookupGitHubItem(repoId, number)
}

export async function lookupGitHubItemByOwnerRepo(
  operations: HostWorkspaceCreationOperations,
  repoId: string,
  slug: RepoSlug,
  number: number,
  type: 'issue' | 'pr'
): Promise<GitHubWorkItem | null> {
  return operations.lookupGitHubItemByOwnerRepo({
    repoId,
    slug,
    number,
    type
  })
}

export async function lookupGitLabItemByPath(
  operations: HostWorkspaceCreationOperations,
  repoId: string,
  link: NonNullable<ReturnType<typeof parseGitLabIssueOrMRLink>>
): Promise<GitLabWorkItem | null> {
  return operations.lookupGitLabItemByPath({
    repoId,
    host: link.slug.host,
    path: link.slug.path,
    iid: link.number,
    type: link.type
  })
}
