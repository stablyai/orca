/* eslint-disable max-lines -- Why: parallel to ipc/github.ts — keeping all
GitLab IPC handlers co-located keeps the repo-path validation pattern
reviewable as one surface. */
import { ipcMain } from 'electron'
import { resolve } from 'path'
import type {
  GitLabIssueUpdate,
  GitLabMRInlineCommentInput,
  GitLabMRUpdate,
  GitLabWorkItem,
  Repo
} from '../../shared/types'
import type { Store } from '../persistence'
import {
  normalizeGitLabIssueAssignee,
  normalizeGitLabIssueListState,
  normalizeGitLabMRListState,
  normalizeGitLabPositiveInteger
} from '../gitlab/gitlab-preload-args'
import { recordGitLabProjectRecent } from '../gitlab/gitlab-project-recents'
import {
  addIssueComment,
  addMRInlineComment,
  addMRComment,
  closeMR,
  createIssue,
  diagnoseAuth,
  getAuthenticatedViewer,
  getJobTrace,
  getIssue,
  getMergeRequest,
  getMergeRequestForBranch,
  getProjectSlug,
  getRateLimit,
  getWorkItemByProjectRef,
  listAssignableUsers,
  listIssues,
  listLabels,
  listMergeRequests,
  listTodos,
  listWorkItems,
  mergeMR,
  reopenMR,
  resolveMRDiscussion,
  retryJob,
  updateIssue,
  updateMR,
  updateMRReviewers
} from '../gitlab/client'
import { getWorkItemDetails } from '../gitlab/work-item-details'
import type { ProjectRef } from '../gitlab/gl-utils'

// Why: mirror github.ts assertRegisteredRepo — main-process handlers
// must never operate on a path the user hasn't explicitly registered as
// a repo (filesystem-auth boundary).
function assertRegisteredRepo(repoPath: string, store: Store): Repo {
  const resolvedRepoPath = resolve(repoPath)
  const repo = store.getRepos().find((r) => resolve(r.path) === resolvedRepoPath)
  if (!repo) {
    throw new Error('Access denied: unknown repository path')
  }
  return repo
}

function repoConnectionId(repo: Repo): string | null {
  return repo.connectionId ?? null
}

export function registerGitLabHandlers(store: Store): void {
  ipcMain.handle('gitlab:viewer', async () => {
    return getAuthenticatedViewer()
  })

  ipcMain.handle('gitlab:diagnoseAuth', async () => diagnoseAuth())

  ipcMain.handle(
    'gitlab:rateLimit',
    async (_event, args?: { force?: boolean; host?: string | null }) =>
      getRateLimit({ force: Boolean(args?.force), host: args?.host ?? null })
  )

  ipcMain.handle('gitlab:projectSlug', async (_event, args: { repoPath: string }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return getProjectSlug(repo.path, repoConnectionId(repo))
  })

  ipcMain.handle(
    'gitlab:mrForBranch',
    async (_event, args: { repoPath: string; branch: string; linkedMRIid?: number | null }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return getMergeRequestForBranch(
        repo.path,
        args.branch,
        args.linkedMRIid ?? null,
        repoConnectionId(repo)
      )
    }
  )

  ipcMain.handle('gitlab:mr', async (_event, args: { repoPath: string; iid: number }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return getMergeRequest(repo.path, args.iid, repoConnectionId(repo))
  })

  ipcMain.handle(
    'gitlab:listMRs',
    async (
      _event,
      args: {
        repoPath: string
        state?: 'opened' | 'merged' | 'closed' | 'all'
        page?: number
        perPage?: number
      }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      const state = normalizeGitLabMRListState(args.state)
      const page = normalizeGitLabPositiveInteger(args.page, 1, 10_000)
      const perPage = normalizeGitLabPositiveInteger(args.perPage, 20, 100)
      return listMergeRequests(
        repo.path,
        state,
        page,
        perPage,
        repo.issueSourcePreference,
        undefined,
        repoConnectionId(repo)
      )
    }
  )

  ipcMain.handle('gitlab:issue', async (_event, args: { repoPath: string; number: number }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return getIssue(repo.path, args.number, repoConnectionId(repo))
  })

  ipcMain.handle(
    'gitlab:listIssues',
    async (
      _event,
      args: {
        repoPath: string
        state?: 'opened' | 'closed' | 'all'
        assignee?: string
        limit?: number
      }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      const limit = normalizeGitLabPositiveInteger(args.limit, 20, 100)
      const state = normalizeGitLabIssueListState(args.state)
      const assignee = normalizeGitLabIssueAssignee(args.assignee)
      const result = await listIssues(
        repo.path,
        limit,
        repo.issueSourcePreference,
        state,
        assignee,
        repoConnectionId(repo)
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
      return { items: workItems, ...(result.error ? { error: result.error } : {}) }
    }
  )

  ipcMain.handle(
    'gitlab:createIssue',
    async (_event, args: { repoPath: string; title: string; body: string }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return createIssue(
        repo.path,
        args.title,
        args.body,
        repo.issueSourcePreference,
        repoConnectionId(repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:updateIssue',
    async (_event, args: { repoPath: string; number: number; updates: GitLabIssueUpdate }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return updateIssue(
        repo.path,
        args.number,
        args.updates,
        repo.issueSourcePreference,
        repoConnectionId(repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:addIssueComment',
    async (_event, args: { repoPath: string; number: number; body: string }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return addIssueComment(
        repo.path,
        args.number,
        args.body,
        repo.issueSourcePreference,
        repoConnectionId(repo)
      )
    }
  )

  ipcMain.handle('gitlab:listLabels', async (_event, args: { repoPath: string }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return listLabels(repo.path, repo.issueSourcePreference, repoConnectionId(repo))
  })

  ipcMain.handle('gitlab:listAssignableUsers', async (_event, args: { repoPath: string }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return listAssignableUsers(repo.path, repo.issueSourcePreference, repoConnectionId(repo))
  })

  // Why: combined MR + issue list — Tasks screen and any future picker
  // that wants a unified view. Centralizes the merge / sort logic so
  // callers don't have to re-implement it.
  ipcMain.handle(
    'gitlab:listWorkItems',
    async (
      _event,
      args: {
        repoPath: string
        state?: 'opened' | 'merged' | 'closed' | 'all'
        page?: number
        perPage?: number
      }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return listWorkItems(
        repo.path,
        normalizeGitLabMRListState(args.state),
        normalizeGitLabPositiveInteger(args.page, 1, 10_000),
        normalizeGitLabPositiveInteger(args.perPage, 20, 100),
        repo.issueSourcePreference,
        undefined,
        repoConnectionId(repo)
      )
    }
  )

  // Why: aggregated dialog payload — body + discussions + pipeline jobs.
  // Powers GitLabItemDialog's tabs.
  ipcMain.handle(
    'gitlab:workItemDetails',
    async (_event, args: { repoPath: string; iid: number; type: 'issue' | 'mr' }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return getWorkItemDetails(
        repo.path,
        args.iid,
        args.type,
        repo.issueSourcePreference,
        repoConnectionId(repo)
      )
    }
  )

  ipcMain.handle('gitlab:closeMR', async (_event, args: { repoPath: string; iid: number }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return closeMR(repo.path, args.iid, repo.issueSourcePreference, repoConnectionId(repo))
  })

  ipcMain.handle('gitlab:reopenMR', async (_event, args: { repoPath: string; iid: number }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return reopenMR(repo.path, args.iid, repo.issueSourcePreference, repoConnectionId(repo))
  })

  ipcMain.handle(
    'gitlab:mergeMR',
    async (
      _event,
      args: { repoPath: string; iid: number; method?: 'merge' | 'squash' | 'rebase' }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return mergeMR(
        repo.path,
        args.iid,
        args.method ?? 'merge',
        repo.issueSourcePreference,
        repoConnectionId(repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:updateMR',
    async (_event, args: { repoPath: string; iid: number; updates: GitLabMRUpdate }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return updateMR(
        repo.path,
        args.iid,
        args.updates,
        repo.issueSourcePreference,
        repoConnectionId(repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:updateMRReviewers',
    async (
      _event,
      args: {
        repoPath: string
        iid: number
        reviewerIds: number[]
        projectRef?: ProjectRef | null
      }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return updateMRReviewers(
        repo.path,
        args.iid,
        args.reviewerIds,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef
      )
    }
  )

  ipcMain.handle(
    'gitlab:addMRComment',
    async (_event, args: { repoPath: string; iid: number; body: string }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return addMRComment(
        repo.path,
        args.iid,
        args.body,
        repo.issueSourcePreference,
        repoConnectionId(repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:addMRInlineComment',
    async (
      _event,
      args: {
        repoPath: string
        iid: number
        input: GitLabMRInlineCommentInput
        projectRef?: ProjectRef | null
      }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return addMRInlineComment(
        repo.path,
        args.iid,
        args.input,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef
      )
    }
  )

  ipcMain.handle(
    'gitlab:resolveMRDiscussion',
    async (
      _event,
      args: { repoPath: string; iid: number; discussionId: string; resolved: boolean }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return resolveMRDiscussion(
        repo.path,
        args.iid,
        args.discussionId,
        args.resolved,
        repo.issueSourcePreference,
        repoConnectionId(repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:jobTrace',
    async (_event, args: { repoPath: string; jobId: number; projectRef?: ProjectRef | null }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return getJobTrace(
        repo.path,
        args.jobId,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef
      )
    }
  )

  ipcMain.handle(
    'gitlab:retryJob',
    async (_event, args: { repoPath: string; jobId: number; projectRef?: ProjectRef | null }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return retryJob(
        repo.path,
        args.jobId,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef
      )
    }
  )

  // Why: My Todos surface — cross-project, user-scoped. The repoPath is
  // only used for the registered-repo guard; `glab api todos` doesn't
  // care about cwd because the endpoint is user-scoped.
  ipcMain.handle('gitlab:todos', async (_event, args: { repoPath: string }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return listTodos(repo.path, repoConnectionId(repo))
  })

  // Why: paste-URL flow in the picker. The user pastes a GitLab URL that
  // may target a project different from the local checkout's remote, so
  // the call carries the parsed project path explicitly rather than
  // resolving from cwd.
  ipcMain.handle(
    'gitlab:workItemByPath',
    async (
      _event,
      args: {
        repoPath: string
        host: string
        path: string
        iid: number
        type: 'issue' | 'mr'
      }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      const projectRef: ProjectRef = { host: args.host, path: args.path }
      const result = await getWorkItemByProjectRef(
        repo.path,
        projectRef,
        args.iid,
        args.type,
        repoConnectionId(repo)
      )
      // Why: only persist a recent entry when the lookup actually
      // produced an item. A 404 / auth failure shouldn't pollute the
      // user's recents list with project paths they can't read.
      if (result) {
        recordGitLabProjectRecent(store, args.host, args.path)
      }
      return result
    }
  )
}
