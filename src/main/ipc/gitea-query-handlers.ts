import { ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import {
  getGiteaPullRequest,
  getGiteaPullRequestForBranch,
  getGiteaRepoSlug
} from '../gitea/client'
import { addGiteaIssueComment, createGiteaIssue } from '../gitea/issue-create'
import { updateGiteaIssue } from '../gitea/issue-update'
import { getGiteaIssue, listGiteaIssues } from '../gitea/issues'
import { listGiteaNotifications, markGiteaNotificationRead } from '../gitea/notifications'
import { listGiteaAssignableUsers, listGiteaLabels } from '../gitea/repo-label-and-assignee-lookup'
import { listGiteaPullRequests } from '../gitea/pull-request-list'
import { listGiteaWorkItems } from '../gitea/work-item-queries'
import { getGiteaWorkItemDetails } from '../gitea/work-item-details'
import type { GiteaIssueUpdate, GiteaProjectRef, PRListState } from '../../shared/gitea-types'
import {
  assertRegisteredGiteaRepo,
  hostedReviewOptionArgs,
  localGitOptionArgs,
  repoConnectionId,
  type GiteaRepoSelectorArgs
} from './gitea-repo-access'

export function registerGiteaQueryHandlers(store: Store): void {
  ipcMain.handle('gitea:projectSlug', async (_event, args: GiteaRepoSelectorArgs) => {
    const repo = assertRegisteredGiteaRepo(args, store)
    const resolved = await getGiteaRepoSlug(
      repo.path,
      repoConnectionId(repo),
      ...hostedReviewOptionArgs(store, repo)
    )
    return resolved ? { host: resolved.host, path: `${resolved.owner}/${resolved.repo}` } : null
  })

  ipcMain.handle(
    'gitea:prForBranch',
    async (
      _event,
      args: GiteaRepoSelectorArgs & { branch: string; linkedPRNumber?: number | null }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return getGiteaPullRequestForBranch(
        repo.path,
        args.branch,
        args.linkedPRNumber ?? null,
        repoConnectionId(repo),
        ...hostedReviewOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle('gitea:pr', async (_event, args: GiteaRepoSelectorArgs & { number: number }) => {
    const repo = assertRegisteredGiteaRepo(args, store)
    return getGiteaPullRequest(
      repo.path,
      args.number,
      repoConnectionId(repo),
      ...hostedReviewOptionArgs(store, repo)
    )
  })

  ipcMain.handle(
    'gitea:listPRs',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        state?: PRListState
        page?: number
        perPage?: number
        query?: string
      }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return listGiteaPullRequests(
        repo.path,
        args.state ?? 'opened',
        args.page ?? 1,
        args.perPage ?? 20,
        repo.issueSourcePreference,
        args.query,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:listWorkItems',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        state?: PRListState
        page?: number
        perPage?: number
        query?: string
      }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return listGiteaWorkItems(
        repo.path,
        args.state ?? 'opened',
        args.page ?? 1,
        args.perPage ?? 20,
        repo.issueSourcePreference,
        args.query,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:issue',
    async (_event, args: GiteaRepoSelectorArgs & { number: number }) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return getGiteaIssue(
        repo.path,
        args.number,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:listIssues',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        state?: 'opened' | 'closed' | 'all'
        assignee?: string
        limit?: number
        page?: number
      }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return listGiteaIssues(
        repo.path,
        args.limit ?? 20,
        repo.issueSourcePreference,
        args.state ?? 'opened',
        args.assignee,
        repoConnectionId(repo),
        localGitOptionArgs(store, repo)[0] ?? {},
        args.page ?? 1
      )
    }
  )

  ipcMain.handle(
    'gitea:createIssue',
    async (_event, args: GiteaRepoSelectorArgs & { title: string; body: string }) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return createGiteaIssue(
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
    'gitea:updateIssue',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        number: number
        updates: GiteaIssueUpdate
        projectRef?: GiteaProjectRef | null
      }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return updateGiteaIssue(
        repo.path,
        args.number,
        args.updates,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:addIssueComment',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        number: number
        body: string
        projectRef?: GiteaProjectRef | null
      }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return addGiteaIssueComment(
        repo.path,
        args.number,
        args.body,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle('gitea:listLabels', async (_event, args: GiteaRepoSelectorArgs) => {
    const repo = assertRegisteredGiteaRepo(args, store)
    return listGiteaLabels(
      repo.path,
      repo.issueSourcePreference,
      repoConnectionId(repo),
      ...localGitOptionArgs(store, repo)
    )
  })

  ipcMain.handle('gitea:listAssignableUsers', async (_event, args: GiteaRepoSelectorArgs) => {
    const repo = assertRegisteredGiteaRepo(args, store)
    return listGiteaAssignableUsers(
      repo.path,
      repo.issueSourcePreference,
      repoConnectionId(repo),
      ...localGitOptionArgs(store, repo)
    )
  })

  ipcMain.handle('gitea:notifications', async (_event, args: GiteaRepoSelectorArgs) => {
    const repo = assertRegisteredGiteaRepo(args, store)
    return listGiteaNotifications(
      repo.path,
      repoConnectionId(repo),
      ...localGitOptionArgs(store, repo)
    )
  })

  ipcMain.handle(
    'gitea:markNotificationRead',
    async (_event, args: GiteaRepoSelectorArgs & { notificationId: number }) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return markGiteaNotificationRead(
        repo.path,
        args.notificationId,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gitea:workItemDetails',
    async (
      _event,
      args: GiteaRepoSelectorArgs & {
        number: number
        type: 'issue' | 'pr'
        includeReviewDetails?: boolean
        projectRef?: GiteaProjectRef | null
      }
    ) => {
      const repo = assertRegisteredGiteaRepo(args, store)
      return getGiteaWorkItemDetails(
        repo.path,
        args.number,
        args.type,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.projectRef,
        localGitOptionArgs(store, repo)[0] ?? {},
        { includeReviewDetails: args.includeReviewDetails }
      )
    }
  )
}
