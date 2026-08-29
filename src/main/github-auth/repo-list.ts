import type { GitHubAccountRepo } from '../../shared/github-account'
import { githubApiGet, type GitHubApiResult } from './api-request'

// Why a cap: `/user/repos` paginates at 100; three pages cover the recently
// active set the panel is for, without unbounded fan-out on huge accounts.
const MAX_REPO_PAGES = 3
const PAGE_SIZE = 100

type RepoPayload = {
  id?: unknown
  name?: unknown
  full_name?: unknown
  description?: unknown
  private?: unknown
  fork?: unknown
  html_url?: unknown
  clone_url?: unknown
  ssh_url?: unknown
  default_branch?: unknown
  language?: unknown
  stargazers_count?: unknown
  pushed_at?: unknown
  owner?: { login?: unknown; avatar_url?: unknown } | null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

// Returns null for entries too incomplete to clone or display.
export function mapRepoPayload(payload: RepoPayload): GitHubAccountRepo | null {
  const id = typeof payload.id === 'number' ? payload.id : null
  const name = asString(payload.name)
  const fullName = asString(payload.full_name)
  const cloneUrl = asString(payload.clone_url)
  const ownerLogin = asString(payload.owner?.login)
  if (id === null || !name || !fullName || !cloneUrl || !ownerLogin) {
    return null
  }
  return {
    id,
    name,
    fullName,
    description: asString(payload.description),
    isPrivate: payload.private === true,
    isFork: payload.fork === true,
    htmlUrl: asString(payload.html_url) ?? `https://github.com/${fullName}`,
    cloneUrl,
    sshUrl: asString(payload.ssh_url) ?? `git@github.com:${fullName}.git`,
    defaultBranch: asString(payload.default_branch) ?? 'main',
    language: asString(payload.language),
    stargazersCount: typeof payload.stargazers_count === 'number' ? payload.stargazers_count : 0,
    pushedAt: asString(payload.pushed_at),
    ownerLogin,
    ownerAvatarUrl: asString(payload.owner?.avatar_url)
  }
}

// `sort=pushed` keeps the most recently active repositories first — the panel's
// primary ordering — and the affiliation filter surfaces private repos the user
// owns or can collaborate on.
export async function listAccessibleGitHubRepos(
  token: string
): Promise<GitHubApiResult<GitHubAccountRepo[]>> {
  const repos: GitHubAccountRepo[] = []
  for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
    const result = await githubApiGet<RepoPayload[]>(
      token,
      `/user/repos?per_page=${PAGE_SIZE}&page=${page}&sort=pushed&direction=desc&affiliation=owner,collaborator,organization_member`
    )
    if (!result.ok) {
      return result
    }
    const entries = Array.isArray(result.data) ? result.data : []
    for (const entry of entries) {
      const mapped = mapRepoPayload(entry)
      if (mapped) {
        repos.push(mapped)
      }
    }
    if (entries.length < PAGE_SIZE) {
      break
    }
  }
  return { ok: true, data: repos }
}
