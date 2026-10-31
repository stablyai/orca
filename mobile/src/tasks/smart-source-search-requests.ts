import type { GitHubWorkItem } from '../../../src/shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../src/shared/gitlab-types'
import type { LinearIssue } from '../../../src/shared/linear/issue-types'
import type { BaseRefSearchResult } from '../../../src/shared/repo-types'
import type { RpcClient } from '../transport/rpc-client'
import type { JiraIssue, JiraSiteSelection } from '../../../src/shared/jira/jira-types'
import { getJiraIssueSearchQuery } from '../../../src/shared/new-workspace/smart-workspace-source-results'
import {
  buildJiraIssueKeyJql,
  buildJiraTextMatchJql
} from '../../../src/shared/jira/jira-search-input-jql'
import { jiraIssueSearchRead } from './mobile-jira-operations'
import { repoBaseRefSearchRead } from './mobile-workspace-source-operations'
import {
  githubWorkItemSearchRead,
  gitlabWorkItemSearchRead,
  linearAssignedIssueListRead,
  linearIssueSearchRead
} from './mobile-task-source-search-operations'
import { PER_REPO_FETCH_LIMIT } from '../../../src/shared/work-items'
import type { MrStateFilter } from './mobile-composer-source-types'

const GITLAB_PER_PAGE = 50
const LINEAR_LIMIT = 50
const JIRA_LIMIT = 50
const BRANCH_LIMIT = 20

// Pass the raw trimmed query: desktop searches issues and PRs, including both for empty input.
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
          filter: 'assigned',
          limit: LINEAR_LIMIT,
          workspaceId: linearWorkspaceId ?? undefined
        })
      )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: linearIssueRowSchema requires all nine members this row is read for (`id`, `identifier`, `title`, `url`, `updatedAt`, `priority`, `labels`, `state`, `team`), so the only gap left is `labelIds`: the schema salvages it to `string[] | undefined` while the shared LinearIssue declares it `string[]`. No mobile code reads it.
  return issues as LinearIssue[]
}

export async function searchJiraIssues(
  client: RpcClient,
  query: string,
  siteId: JiraSiteSelection | null | undefined
): Promise<JiraIssue[]> {
  const searchable = getJiraIssueSearchQuery(query)
  if (!searchable) {
    return []
  }
  // Issue keys are exact lookups; try them before text search.
  const jql = buildJiraIssueKeyJql(searchable) ?? buildJiraTextMatchJql(searchable)
  return jiraIssueSearchRead.interpret(
    await jiraIssueSearchRead.request(client, {
      jql,
      limit: JIRA_LIMIT,
      siteId: siteId ?? undefined
    })
  )
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
