import type { GitHubWorkItem } from '../../../src/shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../src/shared/gitlab-types'
import type { LinearIssue } from '../../../src/shared/linear/issue-types'
import type { BaseRefSearchResult } from '../../../src/shared/repo-types'
import type { RpcClient } from '../transport/rpc-client'
import { repoBaseRefSearchRead } from './mobile-workspace-source-operations'
import {
  githubWorkItemSearchRead,
  gitlabWorkItemSearchRead,
  linearAssignedIssueListRead,
  linearIssueSearchRead
} from './mobile-task-source-search-operations'
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
  const reply = await githubWorkItemSearchRead.request(client, {
    repo: `id:${repoId}`,
    limit: PER_REPO_FETCH_LIMIT,
    query: scopeGitHubQuery(query)
  })
  const envelope = githubWorkItemSearchRead.interpret(reply)
  // Stamp repoId so the shared row builder + create flow can attribute each item
  // to the searched repo (the runtime omits it, like the desktop fetcher).
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `workItemRow` types every member at `GitHubWorkItem`'s own type and requires the ones a consumer reads unguarded, so the assertion only fills in members the row omits; each of those is read through a guard or interpolated as text (task-source-search-reply-schema.ts:10-12).
  return envelope.items.map((item) => ({ ...item, repoId })) as GitHubWorkItem[]
}

export async function searchGitLabItems(
  client: RpcClient,
  repoId: string,
  query: string,
  state: MrStateFilter
): Promise<GitLabWorkItem[]> {
  const reply = await gitlabWorkItemSearchRead.request(client, {
    repo: `id:${repoId}`,
    state,
    page: 1,
    perPage: GITLAB_PER_PAGE,
    query: query.trim() || undefined
  })
  const envelope = gitlabWorkItemSearchRead.interpret(reply)
  if (envelope.error?.type && envelope.error.type !== 'not_found') {
    throw new Error(envelope.error.message ?? '')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same row rule as the GitHub search above, against `GitLabWorkItem`.
  return envelope.items.map((item) => ({ ...item, repoId })) as GitLabWorkItem[]
}

export async function searchLinearIssues(
  client: RpcClient,
  query: string,
  linearWorkspaceId: string | null | undefined
): Promise<LinearIssue[]> {
  const trimmed = query.trim()
  // The reader yields the mobile issue-read shape; the fields the row builder/create flow read
  // (id/identifier/title/url/state/team) are a subset.
  const issues = trimmed
    ? linearIssueSearchRead.interpret(
        await linearIssueSearchRead.request(client, {
          query: trimmed,
          limit: LINEAR_LIMIT,
          workspaceId: linearWorkspaceId ?? undefined
        })
      )
    : linearAssignedIssueListRead.interpret(
        await linearAssignedIssueListRead.request(client, {
          // Empty query lists the viewer's assigned issues, matching desktop's
          // Smart picker default (SmartWorkspaceNameField uses listLinearIssues('assigned')).
          filter: 'assigned',
          limit: LINEAR_LIMIT,
          workspaceId: linearWorkspaceId ?? undefined
        })
      )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the schema requires each row's `id` and nothing else, because the recorded smart-search success carries rows of `{ id }` alone; the row builder's own reads stay where they are.
  return issues as LinearIssue[]
}

export async function searchBranches(
  client: RpcClient,
  repoId: string,
  query: string
): Promise<BaseRefSearchResult[]> {
  const reply = await repoBaseRefSearchRead.request(
    client,
    { repo: `id:${repoId}`, query: query.trim(), limit: BRANCH_LIMIT },
    { timeoutMs: 30_000 }
  )
  const result = repoBaseRefSearchRead.interpret(reply)
  return (
    result.refDetails ??
    (result.refs ?? []).map((refName) => ({ refName, localBranchName: refName }))
  )
}
