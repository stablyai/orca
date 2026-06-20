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
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { TaskSourceContext } from '../../shared/task-source-context'
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
import type { LocalGitExecOptions } from '../gitlab/gitlab-project-ref-resolution'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import type { HostedReviewExecutionOptions } from '../source-control/hosted-review-git-options'

type GitLabRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

function findRegisteredGitLabRepo(args: GitLabRepoSelectorArgs, store: Store): Repo | undefined {
  const sourceRepoId =
    args.sourceContext?.provider === 'gitlab' ? args.sourceContext.repoId?.trim() : null
  const repoId = args.repoId?.trim() || sourceRepoId || null
  if (repoId) {
    const repo = store.getRepo(repoId)
    if (repo) {
      return repo
    }
  }
  const resolvedRepoPath = resolve(args.repoPath)
  return store.getRepos().find((r) => resolve(r.path) === resolvedRepoPath)
}

// Why: mirror github.ts assertRegisteredRepo — main-process handlers
// must never operate on a path the user hasn't explicitly registered as
// a repo (filesystem-auth boundary). Source context adds a host check so a
// task fetched from one machine cannot mutate a same-path repo on another.
function assertRegisteredRepo(args: GitLabRepoSelectorArgs, store: Store): Repo {
  const repo = findRegisteredGitLabRepo(args, store)
  if (!repo) {
    throw new Error('Access denied: unknown repository path')
  }
  if (
    args.sourceContext?.provider === 'gitlab' &&
    args.sourceContext.hostId !== getRepoExecutionHostId(repo)
  ) {
    throw new Error('Access denied: GitLab source host does not match repository host')
  }
  return repo
}

function repoConnectionId(repo: Repo): string | null {
  return repo.connectionId ?? null
}

function localGitOptionArgs(store: Store, repo: Repo): [] | [LocalGitExecOptions] {
  const localGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  return localGitOptions.wslDistro ? [{ wslDistro: localGitOptions.wslDistro }] : []
}

function hostedReviewOptionArgs(store: Store, repo: Repo): [] | [HostedReviewExecutionOptions] {
  const localGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  return localGitOptions.wslDistro
    ? [{ localGitExecOptions: { wslDistro: localGitOptions.wslDistro } }]
    : []
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

  ipcMain.handle('gitlab:projectSlug', async (_event, args: GitLabRepoSelectorArgs) => {
    const repo = assertRegisteredRepo(args, store)
    return getProjectSlug(repo.path, repoConnectionId(repo), ...hostedReviewOptionArgs(store, repo))
  })

  ipcMain.handle(
    'gitlab:mrForBranch',
    async (
      _event,
      args: GitLabRepoSelectorArgs & { branch: string; linkedMRIid?: number | null }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return getMergeRequestForBranch(
        repo.path,
        args.branch,
        args.linkedMRIid ?? null,
        repoConnectionId(repo),
        ...hostedReviewOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle('gitlab:mr', async (_event, args: GitLabRepoSelectorArgs & { iid: number }) => {
    const repo = assertRegisteredRepo(args, store)
    return getMergeRequest(
      repo.path,
      args.iid,
      repoConnectionId(repo),
      ...hostedReviewOptionArgs(store, repo)
    )
  })

  ipcMain.handle(
    'gitlab:listMRs',
    async (
      _event,
      args: {
        repoPath: string
        repoId?: string | null
        sourceContext?: TaskSourceContext | null
        state?: 'opened' | 'merged' | 'closed' | 'all'
        page?: number
        perPage?: number
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
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
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )

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
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      const limit = normalizeGitLabPositiveInteger(args.limit, 20, 100)
      const state = normalizeGitLabIssueListState(args.state)
      const assignee = normalizeGitLabIssueAssignee(args.assignee)
      const result = await listIssues(
        repo.path,
        limit,
        repo.issueSourcePreference,
        state,
        assignee,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
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

  // Why: combined MR + issue list — Tasks screen and any future picker
  // that wants a unified view. Centralizes the merge / sort logic so
  // callers don't have to re-implement it.
  ipcMain.handle(
    'gitlab:listWorkItems',
    async (
      _event,
      args: {
        repoPath: string
        repoId?: string | null
        sourceContext?: TaskSourceContext | null
        state?: 'opened' | 'merged' | 'closed' | 'all'
        page?: number
        perPage?: number
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return listWorkItems(
        repo.path,
        normalizeGitLabMRListState(args.state),
        normalizeGitLabPositiveInteger(args.page, 1, 10_000),
        normalizeGitLabPositiveInteger(args.perPage, 20, 100),
        repo.issueSourcePreference,
        undefined,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  // Why: aggregated dialog payload — body + discussions + pipeline jobs.
  // Powers GitLabItemDialog's tabs.
  ipcMain.handle(
    'gitlab:workItemDetails',
    async (_event, args: GitLabRepoSelectorArgs & { iid: number; type: 'issue' | 'mr' }) => {
      const repo = assertRegisteredRepo(args, store)
      return getWorkItemDetails(
        repo.path,
        args.iid,
        args.type,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        undefined,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:closeMR',
    async (_event, args: GitLabRepoSelectorArgs & { iid: number }) => {
      const repo = assertRegisteredRepo(args, store)
      return closeMR(
        repo.path,
        args.iid,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        undefined,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:reopenMR',
    async (_event, args: GitLabRepoSelectorArgs & { iid: number }) => {
      const repo = assertRegisteredRepo(args, store)
      return reopenMR(
        repo.path,
        args.iid,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        undefined,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:mergeMR',
    async (
      _event,
      args: GitLabRepoSelectorArgs & { iid: number; method?: 'merge' | 'squash' | 'rebase' }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return mergeMR(
        repo.path,
        args.iid,
        args.method ?? 'merge',
        repo.issueSourcePreference,
        repoConnectionId(repo),
        undefined,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:updateMR',
    async (_event, args: GitLabRepoSelectorArgs & { iid: number; updates: GitLabMRUpdate }) => {
      const repo = assertRegisteredRepo(args, store)
      return updateMR(
        repo.path,
        args.iid,
        args.updates,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        undefined,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:updateMRReviewers',
    async (
      _event,
      args: {
        repoPath: string
        repoId?: string | null
        sourceContext?: TaskSourceContext | null
        iid: number
        reviewerIds: number[]
        projectRef?: ProjectRef | null
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return updateMRReviewers(
        repo.path,
        args.iid,
        args.reviewerIds,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:addMRComment',
    async (_event, args: GitLabRepoSelectorArgs & { iid: number; body: string }) => {
      const repo = assertRegisteredRepo(args, store)
      return addMRComment(
        repo.path,
        args.iid,
        args.body,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        undefined,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:addMRInlineComment',
    async (
      _event,
      args: {
        repoPath: string
        repoId?: string | null
        sourceContext?: TaskSourceContext | null
        iid: number
        input: GitLabMRInlineCommentInput
        projectRef?: ProjectRef | null
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return addMRInlineComment(
        repo.path,
        args.iid,
        args.input,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:resolveMRDiscussion',
    async (
      _event,
      args: GitLabRepoSelectorArgs & { iid: number; discussionId: string; resolved: boolean }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return resolveMRDiscussion(
        repo.path,
        args.iid,
        args.discussionId,
        args.resolved,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        undefined,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:jobTrace',
    async (
      _event,
      args: GitLabRepoSelectorArgs & { jobId: number; projectRef?: ProjectRef | null }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return getJobTrace(
        repo.path,
        args.jobId,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitlab:retryJob',
    async (
      _event,
      args: GitLabRepoSelectorArgs & { jobId: number; projectRef?: ProjectRef | null }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return retryJob(
        repo.path,
        args.jobId,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  // Why: My Todos surface — cross-project, user-scoped. The repoPath is
  // only used for the registered-repo guard; `glab api todos` doesn't
  // care about cwd because the endpoint is user-scoped.
  ipcMain.handle('gitlab:todos', async (_event, args: GitLabRepoSelectorArgs) => {
    const repo = assertRegisteredRepo(args, store)
    return listTodos(repo.path, repoConnectionId(repo), ...localGitOptionArgs(store, repo))
  })

  // Why: paste-URL flow in the picker. The user pastes a GitLab URL that
  // may target a project different from the local checkout's remote, so
  // the call carries the parsed project path explicitly rather than
  // resolving from cwd.
  ipcMain.handle(
    'gitlab:workItemByPath',
    async (
      _event,
      args: GitLabRepoSelectorArgs & {
        host: string
        path: string
        iid: number
        type: 'issue' | 'mr'
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      const projectRef: ProjectRef = { host: args.host, path: args.path }
      const result = await getWorkItemByProjectRef(
        repo.path,
        projectRef,
        args.iid,
        args.type,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
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
