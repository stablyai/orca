import type {
  BaseRefSearchResult,
  GitHubWorkItem,
  GitLabWorkItem,
  LinearIssue
} from '../../../src/shared/types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import { extractLinearIssueReadItems } from './linear-mobile-issue-read'
import { PER_REPO_FETCH_LIMIT } from './mobile-work-items'
import type { MrStateFilter } from './mobile-composer-source-types'

const GITLAB_PER_PAGE = 50
const LINEAR_LIMIT = 50
const BRANCH_LIMIT = 20

// Why: the desktop Smart picker returns BOTH issues and PRs — the runtime's
// parseTaskQuery defaults scope 'all', and an empty query lists recent items of
// both types. So pass the raw trimmed query straight through (an explicit
// `is:pr`/`is:issue` the user typed is honored by the runtime); empty stays empty
// so the runtime lists recent issues + PRs.
export function scopeGitHubQuery(query: string): string {
  return query.trim()
}

export async function searchGitHubItems(
  client: RpcClient,
  repoId: string,
  query: string
): Promise<GitHubWorkItem[]> {
  const response = await client.sendRequest('github.listWorkItems', {
    repo: `id:${repoId}`,
    limit: PER_REPO_FETCH_LIMIT,
    query: scopeGitHubQuery(query)
  })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const envelope = (response as RpcSuccess).result as { items: GitHubWorkItem[] }
  // Stamp repoId so the shared row builder + create flow can attribute each item
  // to the searched repo (the runtime omits it, like the desktop fetcher).
  return (envelope.items ?? []).map((item) => ({ ...item, repoId }))
}

export async function searchGitLabItems(
  client: RpcClient,
  repoId: string,
  query: string,
  state: MrStateFilter
): Promise<GitLabWorkItem[]> {
  const response = await client.sendRequest('gitlab.listWorkItems', {
    repo: `id:${repoId}`,
    state,
    page: 1,
    perPage: GITLAB_PER_PAGE,
    query: query.trim() || undefined
  })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const envelope = (response as RpcSuccess).result as {
    items: GitLabWorkItem[]
    error?: { type?: string; message: string }
  }
  if (envelope.error?.type && envelope.error.type !== 'not_found') {
    throw new Error(envelope.error.message)
  }
  return (envelope.items ?? []).map((item) => ({ ...item, repoId }))
}

export async function searchLinearIssues(
  client: RpcClient,
  query: string,
  linearWorkspaceId: string | null | undefined
): Promise<LinearIssue[]> {
  const trimmed = query.trim()
  const response = trimmed
    ? await client.sendRequest('linear.searchIssues', {
        query: trimmed,
        limit: LINEAR_LIMIT,
        workspaceId: linearWorkspaceId ?? undefined
      })
    : await client.sendRequest('linear.listIssues', {
        // Empty query lists the viewer's assigned issues, matching desktop's
        // Smart picker default (SmartWorkspaceNameField uses listLinearIssues('assigned')).
        filter: 'assigned',
        limit: LINEAR_LIMIT,
        workspaceId: linearWorkspaceId ?? undefined
      })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  // extractLinearIssueReadItems yields the mobile issue-read shape; the fields the
  // row builder/create flow read (id/identifier/title/url/state/team) are a subset.
  return extractLinearIssueReadItems((response as RpcSuccess).result) as unknown as LinearIssue[]
}

export async function searchBranches(
  client: RpcClient,
  repoId: string,
  query: string
): Promise<BaseRefSearchResult[]> {
  const response = await client.sendRequest(
    'repo.searchRefs',
    { repo: `id:${repoId}`, query: query.trim(), limit: BRANCH_LIMIT },
    { timeoutMs: 30_000 }
  )
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const result = (response as RpcSuccess).result as {
    refDetails?: BaseRefSearchResult[]
    refs?: string[]
  }
  return (
    result.refDetails ??
    (result.refs ?? []).map((refName) => ({ refName, localBranchName: refName }))
  )
}
