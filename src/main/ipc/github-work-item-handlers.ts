import { ipcMain } from 'electron'
import type { GitHubOwnerRepo, GitHubPRFile } from '../../shared/github/pull-request-types'
import type { GitHubCreateIssueFields } from '../../shared/issue-mutation-types'
import type { TaskSourceContext } from '../../shared/task-source-context'
import {
  countWorkItems,
  createIssue,
  getIssue,
  getWorkItem,
  getWorkItemByOwnerRepo,
  listIssues,
  listWorkItems
} from '../github/client'
import { getPRFileContents, getWorkItemDetails } from '../github/work-item-details'
import type { Store } from '../persistence'
import { dispatchWorkItem, type WorkItemArgs } from './github-work-item-args'
import {
  assertRegisteredGitHubRepo,
  getGitHubLocalGitOptionArgs,
  getGitHubRepoConnectionId,
  readGitHubRepoUnlessWslStopped,
  type GitHubRepoScopedArgs
} from './github-repo-routing'
import { broadcastGitHubWorkItemMutation } from './github-work-item-mutation-events'

// A sidebar card's issue retry is a background read too, so the refusal can't promise one.
const NO_WAKING_RETRY = { retryStartsIt: false }

export function registerGitHubWorkItemHandlers(store: Store): void {
  ipcMain.handle(
    'gh:issue',
    (
      _event,
      args: {
        repoPath: string
        repoId?: string | null
        sourceContext?: TaskSourceContext | null
        number: number
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      // Polled per sidebar card with a linked issue.
      return readGitHubRepoUnlessWslStopped(
        store,
        repo,
        () =>
          getIssue(
            repo.path,
            args.number,
            getGitHubRepoConnectionId(repo),
            ...getGitHubLocalGitOptionArgs(store, repo)
          ),
        NO_WAKING_RETRY
      )
    }
  )

  ipcMain.handle('gh:listIssues', (_event, args: { repoPath: string; limit?: number }) => {
    const repo = assertRegisteredGitHubRepo(args, store)
    return listIssues(
      repo.path,
      args.limit,
      repo.issueSourcePreference,
      getGitHubRepoConnectionId(repo),
      ...getGitHubLocalGitOptionArgs(store, repo)
    ).then((result) => result.items)
  })

  ipcMain.handle(
    'gh:createIssue',
    (
      _event,
      args: GitHubRepoScopedArgs & { title: string; body: string } & GitHubCreateIssueFields
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      const fields =
        args.labels !== undefined || args.assignees !== undefined
          ? { labels: args.labels, assignees: args.assignees }
          : undefined
      return createIssue(
        repo.path,
        args.title,
        args.body,
        repo.issueSourcePreference,
        getGitHubRepoConnectionId(repo),
        fields,
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gh:listWorkItems',
    (
      _event,
      args: {
        repoPath: string
        repoId?: string
        limit?: number
        query?: string
        page?: number
        noCache?: boolean
        /** A Tasks Refresh/Retry/search or single-repo open: a user act that may start the distro. */
        wakeWslDistro?: boolean
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      // A multi-repo Tasks open and the composer fan out across every repo: background (E9).
      return readGitHubRepoUnlessWslStopped(
        store,
        repo,
        () =>
          listWorkItems(
            repo.path,
            args.limit,
            args.query,
            args.page,
            repo.issueSourcePreference,
            getGitHubRepoConnectionId(repo),
            args.noCache,
            ...getGitHubLocalGitOptionArgs(store, repo)
          ),
        { wake: args.wakeWslDistro === true }
      )
    }
  )

  ipcMain.handle(
    'gh:countWorkItems',
    (_event, args: { repoPath: string; query?: string; wakeWslDistro?: boolean }) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      return readGitHubRepoUnlessWslStopped(
        store,
        repo,
        () =>
          countWorkItems(
            repo.path,
            args.query,
            repo.issueSourcePreference,
            getGitHubRepoConnectionId(repo),
            ...getGitHubLocalGitOptionArgs(store, repo)
          ),
        { wake: args.wakeWslDistro === true }
      )
    }
  )

  ipcMain.handle('gh:workItem', (_event, args: WorkItemArgs) => {
    const repo = assertRegisteredGitHubRepo(args, store)
    return dispatchWorkItem(args, repo, getWorkItem, getGitHubLocalGitOptionArgs(store, repo)[0])
  })

  ipcMain.handle(
    'gh:workItemByOwnerRepo',
    (
      _event,
      args: {
        repoPath: string
        owner: string
        repo: string
        host?: string
        number: number
        type: 'issue' | 'pr'
        preview?: boolean
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      return getWorkItemByOwnerRepo(
        repo.path,
        { owner: args.owner, repo: args.repo, ...(args.host ? { host: args.host } : {}) },
        args.number,
        args.type,
        getGitHubRepoConnectionId(repo),
        getGitHubLocalGitOptionArgs(store, repo)[0],
        { preview: args.preview === true }
      )
    }
  )

  ipcMain.handle(
    'gh:workItemDetails',
    (_event, args: WorkItemArgs & { ownerRepo?: GitHubOwnerRepo }) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      return dispatchWorkItem(
        args,
        repo,
        args.ownerRepo
          ? (...params) => getWorkItemDetails(...params, args.ownerRepo)
          : getWorkItemDetails,
        getGitHubLocalGitOptionArgs(store, repo)[0]
      )
    }
  )

  ipcMain.handle(
    'gh:notifyWorkItemMutated',
    (event, args: { repoPath: string; repoId?: string; type: 'issue' | 'pr'; number: number }) => {
      const repo = args.repoId
        ? store.getRepos().find((candidate) => candidate.id === args.repoId)
        : assertRegisteredGitHubRepo(args, store)
      if (!repo) {
        return false
      }
      if (
        (args.type !== 'issue' && args.type !== 'pr') ||
        typeof args.number !== 'number' ||
        !Number.isInteger(args.number) ||
        args.number < 1
      ) {
        return false
      }
      broadcastGitHubWorkItemMutation(
        { repoPath: repo.path, repoId: repo.id, type: args.type, number: args.number },
        event.sender.id
      )
      return true
    }
  )

  ipcMain.handle(
    'gh:prFileContents',
    (
      _event,
      args: {
        repoPath: string
        prNumber: number
        prRepo?: GitHubOwnerRepo | null
        path: string
        oldPath?: string
        status: GitHubPRFile['status']
        headSha: string
        baseSha: string
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      return getPRFileContents({
        repoPath: repo.path,
        connectionId: getGitHubRepoConnectionId(repo),
        localGitOptions: getGitHubLocalGitOptionArgs(store, repo)[0],
        prRepo: args.prRepo ?? null,
        prNumber: args.prNumber,
        path: args.path,
        oldPath: args.oldPath,
        status: args.status,
        headSha: args.headSha,
        baseSha: args.baseSha
      })
    }
  )
}
