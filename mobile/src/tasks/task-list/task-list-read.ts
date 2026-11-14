import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { fetchJiraTaskIssues } from '../providers/jira/mobile-jira-task-source'
import { gitlabTodoListRead } from './mobile-task-list-operations'
import {
  gitlabWorkItemSearchRead,
  linearAssignedIssueListRead,
  linearIssueSearchRead
} from '../providers/mobile-task-source-search-operations'
import { GITHUB_REPO_CONCURRENCY, GITLAB_PER_PAGE, LINEAR_LIMIT } from './mobile-tasks-options'
import type { GitLabWorkItem, RepoSummary } from '../mobile-tasks-provider-detail-types'
import type { TaskItem } from '../mobile-tasks-project-workspace-types'
import { buildPartialRepositoryNotice } from '../repositories/mobile-tasks-repository-presentation'
import {
  createGitLabTask,
  createGitLabTodoTask,
  createJiraTask,
  createLinearTask,
  mapWithConcurrency,
  taskTime
} from '../item-detail/mobile-tasks-item-mapping'
import { sortLinearIssues } from '../item-detail/mobile-tasks-reviewer-linear'
import type { TaskListSnapshot } from '../screen-state/task-queries'
import type { ProviderLoadActionsModel } from './use-mobile-tasks-provider-load-actions'

export type TaskListReadInput = Pick<
  ProviderLoadActionsModel,
  | 'appliedQuery'
  | 'fetchGitHubItemsPage'
  | 'gitlabFilter'
  | 'gitlabView'
  | 'jiraConnection'
  | 'jiraFilter'
  | 'linearFilter'
  | 'linearOrderBy'
  | 'provider'
  | 'selectedLinearTeamIds'
  | 'selectedLinearWorkspaceId'
> & {
  client: RpcClient
  // GitHub and GitLab only: the hosted repos the filter covers, already resolved.
  repos: RepoSummary[]
}

/** One list read for the current filter. Stops before the next repo once `signal` aborts (a newer read replaced it). */
export async function readTaskListRows(
  input: TaskListReadInput,
  signal: AbortSignal
): Promise<TaskListSnapshot> {
  const { appliedQuery, client, provider, repos } = input
  const live = () => !signal.aborted
  if (provider === 'jira') {
    const issues = await fetchJiraTaskIssues(client, {
      jql: appliedQuery,
      filter: input.jiraFilter,
      siteId: input.jiraConnection.selection
    })
    return { items: issues.map(createJiraTask) }
  }
  if (provider === 'linear') {
    const normalizedQuery = appliedQuery.trim()
    const workspaceId = input.selectedLinearWorkspaceId ?? undefined
    const issues = normalizedQuery
      ? linearIssueSearchRead.interpret(
          await linearIssueSearchRead.request(client, {
            query: normalizedQuery,
            limit: LINEAR_LIMIT,
            workspaceId
          })
        )
      : linearAssignedIssueListRead.interpret(
          await linearAssignedIssueListRead.request(client, {
            filter: input.linearFilter,
            limit: LINEAR_LIMIT,
            workspaceId
          })
        )
    const teams = input.selectedLinearTeamIds
    const filtered = teams.size > 0 ? issues.filter((issue) => teams.has(issue.team.id)) : issues
    return { items: sortLinearIssues(filtered, input.linearOrderBy).map(createLinearTask) }
  }
  if (provider === 'github') {
    const page = await input.fetchGitHubItemsPage(client, repos, 0, live)
    if (page.failedCount === repos.length) {
      throw new Error('Failed to load GitHub tasks')
    }
    return {
      items: page.items,
      github: {
        sources: page.sourcesByRepoId,
        sourceErrors: page.sourceErrors,
        sourceFallbacks: page.sourceFallbacks,
        countedTotalPages: null
      },
      notice:
        page.failedCount > 0 ? buildPartialRepositoryNotice(page.failedCount, repos.length) : ''
    }
  }
  if (input.gitlabView === 'todos') {
    const reply = await gitlabTodoListRead.request(client, { repo: `id:${repos[0]!.id}` })
    const todos = gitlabTodoListRead.interpret(reply)
    return {
      items: (todos ?? [])
        .map(createGitLabTodoTask)
        .sort((a, b) => taskTime(b.updatedAt) - taskTime(a.updatedAt))
    }
  }
  const results = await mapWithConcurrency(repos, GITHUB_REPO_CONCURRENCY, async (repo) => {
    if (!live()) {
      return { items: [] }
    }
    try {
      const reply = await gitlabWorkItemSearchRead.request(client, {
        repo: `id:${repo.id}`,
        state: input.gitlabFilter,
        page: 1,
        perPage: GITLAB_PER_PAGE,
        query: appliedQuery.trim() || undefined
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the schema requires `items` and types each row at `GitLabWorkItem`'s own member types, requiring the ones a consumer reads unguarded; the row builder's own reads are unchanged.
      const envelope = gitlabWorkItemSearchRead.interpret(reply) as {
        items: Omit<GitLabWorkItem, 'repoId' | 'repoName'>[]
        error?: { type?: string; message: string }
      }
      if (envelope.error?.type && envelope.error.type !== 'not_found') {
        return { items: [], error: envelope.error.message }
      }
      return { items: envelope.items.map((item) => createGitLabTask(repo, item)) }
    } catch (err) {
      console.warn(`[mobile tasks] failed to fetch ${provider} work items`, repo.id, err)
      return {
        items: [] as TaskItem[],
        error: err instanceof Error ? err.message : 'Failed to load GitLab tasks'
      }
    }
  })
  const failedCount = results.filter((result) => result.error).length
  if (failedCount === repos.length) {
    throw new Error(results.find((result) => result.error)?.error ?? 'Failed to load GitLab tasks')
  }
  return {
    items: results
      .flatMap((result) => result.items)
      .sort((a, b) => taskTime(b.updatedAt) - taskTime(a.updatedAt)),
    notice: failedCount > 0 ? buildPartialRepositoryNotice(failedCount, repos.length) : ''
  }
}
