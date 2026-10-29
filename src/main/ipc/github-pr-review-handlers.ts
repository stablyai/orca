import { ipcMain } from 'electron'
import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import type { TaskSourceContext } from '../../shared/task-source-context'
import { addPRReviewComment, addPRReviewCommentReply, setPRFileViewed } from '../github/client'
import type { Store } from '../persistence'
import {
  assertRegisteredGitHubRepo,
  getGitHubLocalGitOptionArgs,
  getGitHubRepoConnectionId
} from './github-repo-routing'
import { broadcastGitHubWorkItemMutation } from './github-work-item-mutation-events'

export function registerGitHubPRReviewHandlers(store: Store): void {
  ipcMain.handle(
    'gh:setPRFileViewed',
    async (
      event,
      args: {
        repoPath: string
        repoId?: string
        prNumber: number
        prRepo?: GitHubOwnerRepo | null
        pullRequestId: string
        path: string
        viewed: boolean
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      if (
        typeof args.prNumber !== 'number' ||
        !Number.isInteger(args.prNumber) ||
        args.prNumber < 1
      ) {
        return false
      }
      if (!args.pullRequestId?.trim() || !args.path?.trim()) {
        return false
      }
      const ok = await setPRFileViewed({
        repoPath: repo.path,
        connectionId: getGitHubRepoConnectionId(repo),
        localGitOptions: getGitHubLocalGitOptionArgs(store, repo)[0],
        prRepo: args.prRepo ?? null,
        pullRequestId: args.pullRequestId.trim(),
        path: args.path,
        viewed: Boolean(args.viewed)
      })
      if (ok) {
        broadcastGitHubWorkItemMutation(
          { repoPath: repo.path, repoId: repo.id, type: 'pr', number: args.prNumber },
          event.sender.id
        )
      }
      return ok
    }
  )

  ipcMain.handle(
    'gh:addPRReviewCommentReply',
    async (
      event,
      args: {
        repoPath: string
        repoId?: string
        sourceContext?: TaskSourceContext | null
        prNumber: number
        commentId: number
        body: string
        threadId?: string
        path?: string
        line?: number
        prRepo?: GitHubOwnerRepo | null
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      if (
        typeof args.prNumber !== 'number' ||
        !Number.isInteger(args.prNumber) ||
        args.prNumber < 1
      ) {
        return { ok: false, error: 'Invalid PR number' }
      }
      if (
        typeof args.commentId !== 'number' ||
        !Number.isInteger(args.commentId) ||
        args.commentId < 1
      ) {
        return { ok: false, error: 'Invalid comment ID' }
      }
      if (!args.body?.trim()) {
        return { ok: false, error: 'Comment body required' }
      }
      const result = await addPRReviewCommentReply(
        repo.path,
        args.prNumber,
        args.commentId,
        args.body.trim(),
        args.threadId,
        args.path,
        args.line,
        getGitHubRepoConnectionId(repo),
        args.prRepo ?? null,
        ...getGitHubLocalGitOptionArgs(store, repo)
      )
      if (result.ok) {
        broadcastGitHubWorkItemMutation(
          { repoPath: repo.path, repoId: repo.id, type: 'pr', number: args.prNumber },
          event.sender.id
        )
      }
      return result
    }
  )

  ipcMain.handle(
    'gh:addPRReviewComment',
    async (
      event,
      args: {
        repoPath: string
        prNumber: number
        prRepo?: GitHubOwnerRepo | null
        commitId: string
        path: string
        line: number
        startLine?: number
        body: string
      }
    ) => {
      const repo = assertRegisteredGitHubRepo(args, store)
      if (
        typeof args.prNumber !== 'number' ||
        !Number.isInteger(args.prNumber) ||
        args.prNumber < 1
      ) {
        return { ok: false, error: 'Invalid PR number' }
      }
      if (typeof args.line !== 'number' || !Number.isInteger(args.line) || args.line < 1) {
        return { ok: false, error: 'Invalid line number' }
      }
      if (
        args.startLine !== undefined &&
        (typeof args.startLine !== 'number' ||
          !Number.isInteger(args.startLine) ||
          args.startLine < 1 ||
          args.startLine > args.line)
      ) {
        return { ok: false, error: 'Invalid start line' }
      }
      if (!args.commitId?.trim()) {
        return { ok: false, error: 'Missing PR head SHA' }
      }
      if (!args.path?.trim()) {
        return { ok: false, error: 'File path required' }
      }
      if (!args.body?.trim()) {
        return { ok: false, error: 'Comment body required' }
      }
      const result = await addPRReviewComment({
        repoPath: repo.path,
        prRepo: args.prRepo ?? null,
        prNumber: args.prNumber,
        commitId: args.commitId.trim(),
        path: args.path,
        line: args.line,
        startLine: args.startLine,
        body: args.body.trim(),
        connectionId: getGitHubRepoConnectionId(repo),
        localGitOptions: getGitHubLocalGitOptionArgs(store, repo)[0]
      })
      if (result.ok) {
        broadcastGitHubWorkItemMutation(
          { repoPath: repo.path, repoId: repo.id, type: 'pr', number: args.prNumber },
          event.sender.id
        )
      }
      return result
    }
  )
}
