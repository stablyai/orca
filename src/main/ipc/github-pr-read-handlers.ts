import { ipcMain } from 'electron'
import type { GitHubReactionContent } from '../../shared/github/comment-types'
import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import type { TaskSourceContext } from '../../shared/task-source-context'
import {
  getPRCheckDetails,
  getPRChecks,
  getPRComments,
  getRepoSlug,
  getRepoUpstream,
  resolveReviewThread,
  setPRCommentReaction
} from '../github/client'
import type { Store } from '../persistence'
import {
  assertRegisteredGitHubRepo,
  getGitHubLocalGitOptionArgs,
  getGitHubRepoConnectionId
} from './github-repo-routing'

export function registerGitHubPRReadHandlers(store: Store): void {
  ipcMain.handle('gh:repoSlug', (_event, args: { repoPath: string }) => {
    const repo = assertRegisteredGitHubRepo(args, store)
    const localGitOptions = getGitHubLocalGitOptionArgs(store, repo)[0]
    return localGitOptions
      ? getRepoSlug(repo.path, getGitHubRepoConnectionId(repo), {
          localGitExecOptions: localGitOptions
        })
      : getRepoSlug(repo.path, getGitHubRepoConnectionId(repo))
  })

  ipcMain.handle('gh:repoUpstream', (_event, args: { repoPath: string }) => {
    const repo = assertRegisteredGitHubRepo(args, store)
    const localGitOptions = getGitHubLocalGitOptionArgs(store, repo)[0]
    return localGitOptions
      ? getRepoUpstream(repo.path, getGitHubRepoConnectionId(repo), {
          localGitExecOptions: localGitOptions
        })
      : getRepoUpstream(repo.path, getGitHubRepoConnectionId(repo))
  })

  ipcMain.handle(
    'gh:prChecks',
    (
      _event,
      args: {
        repoPath: string
        repoId?: string | null
        sourceContext?: TaskSourceContext | null
        prNumber: number
        headSha?: string
        prRepo?: GitHubOwnerRepo | null
        noCache?: boolean
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      return getPRChecks(
        repo.path,
        args.prNumber,
        args.headSha,
        args.prRepo ?? null,
        { noCache: args.noCache },
        getGitHubRepoConnectionId(repo),
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gh:prCheckDetails',
    (
      _event,
      args: {
        repoPath: string
        repoId?: string | null
        sourceContext?: TaskSourceContext | null
        checkRunId?: number
        workflowRunId?: number
        checkName?: string
        url?: string | null
        prRepo?: GitHubOwnerRepo | null
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      return getPRCheckDetails(
        repo.path,
        {
          checkRunId: args.checkRunId,
          workflowRunId: args.workflowRunId,
          checkName: args.checkName,
          url: args.url,
          prRepo: args.prRepo ?? null
        },
        getGitHubRepoConnectionId(repo),
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gh:prComments',
    (
      _event,
      args: {
        repoPath: string
        repoId?: string | null
        sourceContext?: TaskSourceContext | null
        prNumber: number
        prRepo?: GitHubOwnerRepo | null
        noCache?: boolean
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      return getPRComments(
        repo.path,
        args.prNumber,
        { noCache: args.noCache, prRepo: args.prRepo ?? null },
        getGitHubRepoConnectionId(repo),
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gh:setPRCommentReaction',
    (
      _event,
      args: {
        repoPath: string
        repoId?: string | null
        sourceContext?: TaskSourceContext | null
        reactionSubjectId: string
        content: GitHubReactionContent
        reacted: boolean
        prRepo?: GitHubOwnerRepo | null
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      if (!args.reactionSubjectId?.trim()) {
        return false
      }
      return setPRCommentReaction(
        repo.path,
        args.reactionSubjectId.trim(),
        args.content,
        args.reacted,
        getGitHubRepoConnectionId(repo),
        args.prRepo ?? null,
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gh:resolveReviewThread',
    async (
      _event,
      args: {
        repoPath: string
        repoId?: string | null
        sourceContext?: TaskSourceContext | null
        threadId: string
        resolve: boolean
        prRepo?: GitHubOwnerRepo | null
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      return resolveReviewThread(
        repo.path,
        args.threadId,
        args.resolve,
        getGitHubRepoConnectionId(repo),
        args.prRepo ?? null,
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
    }
  )
}
