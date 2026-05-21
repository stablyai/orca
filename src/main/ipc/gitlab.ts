/* eslint-disable max-lines -- Why: parallel to ipc/github.ts — keeping all
GitLab IPC handlers co-located keeps the repo-path validation pattern
reviewable as one surface. */
import { ipcMain } from 'electron'
import { resolve } from 'path'
import type { GitLabIssueUpdate, GitLabWorkItem, MRListState, Repo } from '../../shared/types'
import type { Store } from '../persistence'
import {
  addIssueComment,
  addMRComment,
  closeMR,
  createIssue,
  getAuthenticatedViewer,
  getIssue,
  getMergeRequest,
  getMergeRequestForBranch,
  getProjectSlug,
  getWorkItemByProjectRef,
  listAssignableUsers,
  listIssues,
  listLabels,
  listMergeRequests,
  listTodos,
  listWorkItems,
  mergeMR,
  reopenMR,
  updateIssue
} from '../gitlab/client'
import { getWorkItemDetails } from '../gitlab/work-item-details'
import { computeNextGitLabRecents } from '../../shared/gitlab-projects'
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

function normalizePositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(Math.max(1, Math.trunc(value)), max)
}

function normalizeMRListState(value: unknown): MRListState {
  return value === 'merged' || value === 'closed' || value === 'all' ? value : 'opened'
}

type GitLabIssueListState = 'opened' | 'closed' | 'all'

function normalizeIssueListState(value: unknown): GitLabIssueListState {
  return value === 'closed' || value === 'all' ? value : 'opened'
}

function normalizeIssueAssignee(value: unknown): '@me' | undefined {
  // Why: the renderer only exposes "Assigned to me"; accepting arbitrary
  // values here would turn this IPC boundary into a generic glab flag surface.
  return value === '@me' ? '@me' : undefined
}

export function registerGitLabHandlers(store: Store): void {
  ipcMain.handle('gitlab:viewer', async () => {
    return getAuthenticatedViewer()
  })

  ipcMain.handle('gitlab:projectSlug', async (_event, args: { repoPath: string }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return getProjectSlug(repo.path)
  })

  ipcMain.handle(
    'gitlab:mrForBranch',
    async (_event, args: { repoPath: string; branch: string; linkedMRIid?: number | null }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return getMergeRequestForBranch(repo.path, args.branch, args.linkedMRIid ?? null)
    }
  )

  ipcMain.handle('gitlab:mr', async (_event, args: { repoPath: string; iid: number }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return getMergeRequest(repo.path, args.iid)
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
      const state = normalizeMRListState(args.state)
      const page = normalizePositiveInteger(args.page, 1, 10_000)
      const perPage = normalizePositiveInteger(args.perPage, 20, 100)
      const result = await listMergeRequests(repo.path, state, page, perPage)
      return result
    }
  )

  ipcMain.handle('gitlab:issue', async (_event, args: { repoPath: string; number: number }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return getIssue(repo.path, args.number)
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
      const limit = normalizePositiveInteger(args.limit, 20, 100)
      const state = normalizeIssueListState(args.state)
      const assignee = normalizeIssueAssignee(args.assignee)
      const result = await listIssues(repo.path, limit, undefined, state, assignee)
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
      return createIssue(repo.path, args.title, args.body)
    }
  )

  ipcMain.handle(
    'gitlab:updateIssue',
    async (_event, args: { repoPath: string; number: number; updates: GitLabIssueUpdate }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return updateIssue(repo.path, args.number, args.updates)
    }
  )

  ipcMain.handle(
    'gitlab:addIssueComment',
    async (_event, args: { repoPath: string; number: number; body: string }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return addIssueComment(repo.path, args.number, args.body)
    }
  )

  ipcMain.handle('gitlab:listLabels', async (_event, args: { repoPath: string }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return listLabels(repo.path)
  })

  ipcMain.handle('gitlab:listAssignableUsers', async (_event, args: { repoPath: string }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return listAssignableUsers(repo.path)
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
        normalizeMRListState(args.state),
        normalizePositiveInteger(args.page, 1, 10_000),
        normalizePositiveInteger(args.perPage, 20, 100)
      )
    }
  )

  // Why: aggregated dialog payload — body + discussions + pipeline jobs.
  // Powers GitLabItemDialog's tabs.
  ipcMain.handle(
    'gitlab:workItemDetails',
    async (_event, args: { repoPath: string; iid: number; type: 'issue' | 'mr' }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return getWorkItemDetails(repo.path, args.iid, args.type)
    }
  )

  ipcMain.handle('gitlab:closeMR', async (_event, args: { repoPath: string; iid: number }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return closeMR(repo.path, args.iid)
  })

  ipcMain.handle('gitlab:reopenMR', async (_event, args: { repoPath: string; iid: number }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return reopenMR(repo.path, args.iid)
  })

  ipcMain.handle(
    'gitlab:mergeMR',
    async (
      _event,
      args: { repoPath: string; iid: number; method?: 'merge' | 'squash' | 'rebase' }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return mergeMR(repo.path, args.iid, args.method ?? 'merge')
    }
  )

  ipcMain.handle(
    'gitlab:addMRComment',
    async (_event, args: { repoPath: string; iid: number; body: string }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return addMRComment(repo.path, args.iid, args.body)
    }
  )

  // Why: My Todos surface — cross-project, user-scoped. The repoPath is
  // only used for the registered-repo guard; `glab api todos` doesn't
  // care about cwd because the endpoint is user-scoped.
  ipcMain.handle('gitlab:todos', async (_event, args: { repoPath: string }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return listTodos(repo.path)
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
      const result = await getWorkItemByProjectRef(repo.path, projectRef, args.iid, args.type)
      // Why: only persist a recent entry when the lookup actually
      // produced an item. A 404 / auth failure shouldn't pollute the
      // user's recents list with project paths they can't read.
      if (result) {
        addGitLabProjectToRecent(store, args.host, args.path)
      }
      return result
    }
  )
}

function addGitLabProjectToRecent(store: Store, host: string, path: string): void {
  const settings = store.getSettings()
  const existing = settings.gitlabProjects ?? { pinned: [], recent: [] }
  store.updateSettings({
    gitlabProjects: {
      pinned: existing.pinned,
      recent: computeNextGitLabRecents(existing.recent, host, path)
    }
  })
}
