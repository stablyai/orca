import { ipcMain } from 'electron'
import type { GitLabIssueUpdate, GitLabWorkItem } from '../../shared/gitlab-types'
import type { TaskSourceContext } from '../../shared/task-source-context'
import type { Store } from '../persistence'
import {
  normalizeGitLabIssueAssignee,
  normalizeGitLabIssueListState,
  normalizeGitLabPositiveInteger
} from '../gitlab/gitlab-preload-args'
import {
  addIssueComment,
  createIssue,
  getIssue,
  listAssignableUsers,
  listIssues,
  listLabels,
  updateIssue
} from '../gitlab/client'
import type { GitLabRepoSelectorArgs } from './gitlab-repo-access'
import { assertRegisteredRepo, localGitOptionArgs, repoConnectionId } from './gitlab-repo-access'

export function registerGitLabIssueHandlers(store: Store): void {
  ipcMain.handle(
    'gitlab:issue',
    async (_event, args: GitLabRepoSelectorArgs & { number: number }) => {
      const repo = assertRegisteredRepo(args, store)
      return getIssue(
        repo.path,
        args.number,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:listIssues',
    async (
      _event,
      args: {
        repoPath: string
        repoId?: string | null
        sourceContext?: TaskSourceContext | null
        state?: 'opened' | 'closed' | 'all'
        assignee?: string
        limit?: number
        page?: number
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      const limit = normalizeGitLabPositiveInteger(args.limit, 20, 100)
      const page = normalizeGitLabPositiveInteger(args.page, 1, 10_000)
      const state = normalizeGitLabIssueListState(args.state)
      const assignee = normalizeGitLabIssueAssignee(args.assignee)
      const result = await listIssues(
        repo.path,
        limit,
        repo.issueSourcePreference,
        state,
        assignee,
        repoConnectionId(repo),
        localGitOptionArgs(store, repo)[0] ?? {},
        page
      )
      // Why: Tasks page expects GitLabWorkItem[] so it can share row
      // rendering with MRs. Map IssueInfo → WorkItem here so the renderer
      // doesn't need a separate code path.
      const workItems: GitLabWorkItem[] = result.items.map((issue) => ({
        id: `gitlab-issue-${repo.id}-${issue.number}`,
        type: 'issue' as const,
        number: issue.number,
        title: issue.title,
        state: issue.state,
        url: issue.url,
        labels: issue.labels,
        updatedAt: issue.updatedAt ?? '',
        author: issue.author ?? null,
        repoId: repo.id
      }))
      return {
        items: workItems,
        totalPages: result.totalPages,
        ...(result.error ? { error: result.error } : {})
      }
    }
  )

  ipcMain.handle(
    'gitlab:createIssue',
    async (_event, args: GitLabRepoSelectorArgs & { title: string; body: string }) => {
      const repo = assertRegisteredRepo(args, store)
      return createIssue(
        repo.path,
        args.title,
        args.body,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:updateIssue',
    async (
      _event,
      args: GitLabRepoSelectorArgs & { number: number; updates: GitLabIssueUpdate }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return updateIssue(
        repo.path,
        args.number,
        args.updates,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        undefined,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:addIssueComment',
    async (_event, args: GitLabRepoSelectorArgs & { number: number; body: string }) => {
      const repo = assertRegisteredRepo(args, store)
      return addIssueComment(
        repo.path,
        args.number,
        args.body,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        undefined,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle('gitlab:listLabels', async (_event, args: GitLabRepoSelectorArgs) => {
    const repo = assertRegisteredRepo(args, store)
    return listLabels(
      repo.path,
      repo.issueSourcePreference,
      repoConnectionId(repo),
      ...localGitOptionArgs(store, repo)
    )
  })

  ipcMain.handle('gitlab:listAssignableUsers', async (_event, args: GitLabRepoSelectorArgs) => {
    const repo = assertRegisteredRepo(args, store)
    return listAssignableUsers(
      repo.path,
      repo.issueSourcePreference,
      repoConnectionId(repo),
      ...localGitOptionArgs(store, repo)
    )
  })
}
