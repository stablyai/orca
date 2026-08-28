import { ipcMain } from 'electron'
import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import type { GitHubPullRequestStateUpdate } from '../../shared/issue-mutation-types'
import {
  mergePR,
  removePRReviewers,
  requestPRReviewers,
  rerunPRChecks,
  setPRAutoMerge,
  updatePRState,
  updatePRTitle
} from '../github/client'
import type { Store } from '../persistence'
import {
  assertRegisteredGitHubRepo,
  getGitHubLocalGitOptionArgs,
  getGitHubRepoConnectionId,
  type GitHubRepoScopedArgs
} from './github-repo-routing'
import { broadcastGitHubWorkItemMutation } from './github-work-item-mutation-events'

function broadcastSuccessfulPRMutation(
  ok: boolean,
  repoPath: string,
  repoId: string,
  prNumber: number,
  senderId: number
): void {
  if (ok) {
    broadcastGitHubWorkItemMutation({ repoPath, repoId, type: 'pr', number: prNumber }, senderId)
  }
}

export function registerGitHubPRMutationHandlers(store: Store): void {
  ipcMain.handle(
    'gh:updatePRTitle',
    async (
      event,
      args: { repoPath: string; prNumber: number; title: string; prRepo?: GitHubOwnerRepo | null }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      const ok = await updatePRTitle(
        repo.path,
        args.prNumber,
        args.title,
        getGitHubRepoConnectionId(repo),
        args.prRepo ?? null,
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
      broadcastSuccessfulPRMutation(ok, repo.path, repo.id, args.prNumber, event.sender.id)
      return ok
    }
  )

  ipcMain.handle(
    'gh:mergePR',
    async (
      event,
      args: GitHubRepoScopedArgs & {
        prNumber: number
        method?: 'merge' | 'squash' | 'rebase'
        prRepo?: GitHubOwnerRepo | null
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      const result = await mergePR(
        repo.path,
        args.prNumber,
        args.method,
        getGitHubRepoConnectionId(repo),
        args.prRepo ?? null,
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
      broadcastSuccessfulPRMutation(result.ok, repo.path, repo.id, args.prNumber, event.sender.id)
      return result
    }
  )

  ipcMain.handle(
    'gh:setPRAutoMerge',
    async (
      event,
      args: GitHubRepoScopedArgs & {
        prNumber: number
        enabled: boolean
        method?: 'merge' | 'squash' | 'rebase'
        prRepo?: GitHubOwnerRepo | null
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      const result = await setPRAutoMerge(
        repo.path,
        args.prNumber,
        args.enabled,
        args.method,
        getGitHubRepoConnectionId(repo),
        args.prRepo ?? null,
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
      broadcastSuccessfulPRMutation(result.ok, repo.path, repo.id, args.prNumber, event.sender.id)
      return result
    }
  )

  ipcMain.handle(
    'gh:updatePRState',
    async (
      event,
      args: GitHubRepoScopedArgs & {
        prNumber: number
        updates: GitHubPullRequestStateUpdate
        prRepo?: GitHubOwnerRepo | null
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      if (
        typeof args.prNumber !== 'number' ||
        !Number.isInteger(args.prNumber) ||
        args.prNumber < 1
      ) {
        return { ok: false, error: 'Invalid pull request number' }
      }
      const result = await updatePRState(
        repo.path,
        args.prNumber,
        args.updates,
        getGitHubRepoConnectionId(repo),
        args.prRepo ?? null,
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
      broadcastSuccessfulPRMutation(result.ok, repo.path, repo.id, args.prNumber, event.sender.id)
      return result
    }
  )

  ipcMain.handle(
    'gh:rerunPRChecks',
    async (
      _event,
      args: GitHubRepoScopedArgs & {
        prNumber: number
        headSha?: string
        failedOnly?: boolean
        prRepo?: GitHubOwnerRepo | null
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      if (
        typeof args.prNumber !== 'number' ||
        !Number.isInteger(args.prNumber) ||
        args.prNumber < 1
      ) {
        return { ok: false, error: 'Invalid pull request number' }
      }
      return rerunPRChecks(
        repo.path,
        args.prNumber,
        { headSha: args.headSha, failedOnly: args.failedOnly, prRepo: args.prRepo ?? null },
        getGitHubRepoConnectionId(repo),
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gh:requestPRReviewers',
    async (
      event,
      args: GitHubRepoScopedArgs & {
        prNumber: number
        reviewers: string[]
        prRepo?: GitHubOwnerRepo | null
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      const result = await requestPRReviewers(
        repo.path,
        args.prNumber,
        args.reviewers,
        getGitHubRepoConnectionId(repo),
        args.prRepo ?? null,
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
      broadcastSuccessfulPRMutation(result.ok, repo.path, repo.id, args.prNumber, event.sender.id)
      return result
    }
  )

  ipcMain.handle(
    'gh:removePRReviewers',
    async (
      event,
      args: GitHubRepoScopedArgs & {
        prNumber: number
        reviewers: string[]
        prRepo?: GitHubOwnerRepo | null
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      const result = await removePRReviewers(
        repo.path,
        args.prNumber,
        args.reviewers,
        getGitHubRepoConnectionId(repo),
        args.prRepo ?? null,
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
      broadcastSuccessfulPRMutation(result.ok, repo.path, repo.id, args.prNumber, event.sender.id)
      return result
    }
  )
}
