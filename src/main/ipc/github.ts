/* eslint-disable max-lines -- Why: all GitHub IPC handlers stay co-located so
the repo-path validation, preference-threading, and stats wiring patterns are
reviewable as one surface. Splitting by feature area would risk drifting
validation/gate conventions across handler files. */
import { ipcMain } from 'electron'
import { resolve } from 'path'
import type { Repo, GitHubIssueUpdate, IssueSourcePreference } from '../../shared/types'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import {
  getPRForBranch,
  getIssue,
  getRepoSlug,
  listIssues,
  listWorkItems,
  countWorkItems,
  getWorkItem,
  createIssue,
  updateIssue,
  addIssueComment,
  listLabels,
  listAssignableUsers,
  getAuthenticatedViewer,
  getPRChecks,
  getPRComments,
  resolveReviewThread,
  addPRReviewComment,
  addPRReviewCommentReply,
  updatePRTitle,
  mergePR,
  checkOrcaStarred,
  starOrca
} from '../github/client'
import { getWorkItemDetails, getPRFileContents } from '../github/work-item-details'
import type { GitHubPRFile } from '../../shared/types'
import { dispatchWorkItem, type WorkItemArgs } from './github-work-item-args'

// Why: returns the full Repo object instead of just the path string so that
// callers have access to repo.id for stat tracking and other context.
function assertRegisteredRepo(repoPath: string, store: Store): Repo {
  const resolvedRepoPath = resolve(repoPath)
  const repo = store.getRepos().find((r) => resolve(r.path) === resolvedRepoPath)
  if (!repo) {
    throw new Error('Access denied: unknown repository path')
  }
  return repo
}

// Why: ensure only the three valid values make it through the IPC boundary —
// an unknown value from a stale preload/renderer is coerced to `undefined`
// ('auto') rather than propagating into persistence or resolver logic.
function coerceIssueSourcePreference(value: unknown): IssueSourcePreference | undefined {
  if (value === 'upstream' || value === 'origin' || value === 'auto') {
    return value
  }
  return undefined
}

export function registerGitHubHandlers(store: Store, stats: StatsCollector): void {
  ipcMain.handle('gh:prForBranch', async (_event, args: { repoPath: string; branch: string }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    const pr = await getPRForBranch(repo.path, args.branch)
    // Emit pr_created when a PR is first detected for a branch.
    // Why here: the renderer polls gh:prForBranch to check PR status per worktree.
    // This captures PRs opened from any workflow (Orca UI, gh CLI, github.com).
    if (pr && !stats.hasCountedPR(pr.url)) {
      stats.record({
        type: 'pr_created',
        at: Date.now(),
        repoId: repo.id,
        meta: { prNumber: pr.number, prUrl: pr.url }
      })
    }
    return pr
  })

  ipcMain.handle('gh:issue', (_event, args: { repoPath: string; number: number }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return getIssue(repo.path, args.number)
  })

  ipcMain.handle('gh:listIssues', (_event, args: { repoPath: string; limit?: number }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    // Why: listIssues now returns { items, error? }. The IPC handler unwraps to
    // the items array for the existing contract; feature 1's UI consumes the
    // richer envelope through `gh:listWorkItems` instead.
    return listIssues(repo.path, args.limit, repo.issueSourcePreference).then((r) => r.items)
  })

  ipcMain.handle(
    'gh:createIssue',
    (_event, args: { repoPath: string; title: string; body: string }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return createIssue(repo.path, args.title, args.body, repo.issueSourcePreference)
    }
  )

  ipcMain.handle(
    'gh:listWorkItems',
    (_event, args: { repoPath: string; limit?: number; query?: string; before?: string }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return listWorkItems(
        repo.path,
        args.limit,
        args.query,
        args.before,
        repo.issueSourcePreference
      )
    }
  )

  ipcMain.handle('gh:countWorkItems', (_event, args: { repoPath: string; query?: string }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return countWorkItems(repo.path, args.query, repo.issueSourcePreference)
  })

  ipcMain.handle('gh:workItem', (_event, args: WorkItemArgs) =>
    dispatchWorkItem(args, assertRegisteredRepo(args.repoPath, store).path, getWorkItem)
  )
  ipcMain.handle('gh:workItemDetails', (_event, args: WorkItemArgs) =>
    dispatchWorkItem(args, assertRegisteredRepo(args.repoPath, store).path, getWorkItemDetails)
  )

  ipcMain.handle(
    'gh:prFileContents',
    (
      _event,
      args: {
        repoPath: string
        prNumber: number
        path: string
        oldPath?: string
        status: GitHubPRFile['status']
        headSha: string
        baseSha: string
      }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return getPRFileContents({
        repoPath: repo.path,
        prNumber: args.prNumber,
        path: args.path,
        oldPath: args.oldPath,
        status: args.status,
        headSha: args.headSha,
        baseSha: args.baseSha
      })
    }
  )

  ipcMain.handle('gh:repoSlug', (_event, args: { repoPath: string }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return getRepoSlug(repo.path)
  })

  ipcMain.handle(
    'gh:prChecks',
    (
      _event,
      args: {
        repoPath: string
        prNumber: number
        headSha?: string
        noCache?: boolean
      }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return getPRChecks(repo.path, args.prNumber, args.headSha, {
        noCache: args.noCache
      })
    }
  )

  ipcMain.handle(
    'gh:prComments',
    (_event, args: { repoPath: string; prNumber: number; noCache?: boolean }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return getPRComments(repo.path, args.prNumber, { noCache: args.noCache })
    }
  )

  ipcMain.handle(
    'gh:resolveReviewThread',
    (_event, args: { repoPath: string; threadId: string; resolve: boolean }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return resolveReviewThread(repo.path, args.threadId, args.resolve)
    }
  )

  ipcMain.handle(
    'gh:addPRReviewCommentReply',
    (
      _event,
      args: {
        repoPath: string
        prNumber: number
        commentId: number
        body: string
        threadId?: string
        path?: string
        line?: number
      }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
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
      return addPRReviewCommentReply(
        repo.path,
        args.prNumber,
        args.commentId,
        args.body.trim(),
        args.threadId,
        args.path,
        args.line
      )
    }
  )

  ipcMain.handle(
    'gh:addPRReviewComment',
    (
      _event,
      args: {
        repoPath: string
        prNumber: number
        commitId: string
        path: string
        line: number
        startLine?: number
        body: string
      }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
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
      return addPRReviewComment({
        repoPath: repo.path,
        prNumber: args.prNumber,
        commitId: args.commitId.trim(),
        path: args.path,
        line: args.line,
        startLine: args.startLine,
        body: args.body.trim()
      })
    }
  )

  ipcMain.handle(
    'gh:updatePRTitle',
    (_event, args: { repoPath: string; prNumber: number; title: string }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return updatePRTitle(repo.path, args.prNumber, args.title)
    }
  )

  ipcMain.handle(
    'gh:mergePR',
    (
      _event,
      args: { repoPath: string; prNumber: number; method?: 'merge' | 'squash' | 'rebase' }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      return mergePR(repo.path, args.prNumber, args.method)
    }
  )

  ipcMain.handle(
    'gh:updateIssue',
    (_event, args: { repoPath: string; number: number; updates: GitHubIssueUpdate }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      if (typeof args.number !== 'number' || !Number.isInteger(args.number) || args.number < 1) {
        return { ok: false, error: 'Invalid issue number' }
      }
      if (!args.updates || typeof args.updates !== 'object') {
        return { ok: false, error: 'Updates object is required' }
      }
      return updateIssue(repo.path, args.number, args.updates, repo.issueSourcePreference)
    }
  )

  ipcMain.handle(
    'gh:addIssueComment',
    (_event, args: { repoPath: string; number: number; body: string }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      if (typeof args.number !== 'number' || !Number.isInteger(args.number) || args.number < 1) {
        return { ok: false, error: 'Invalid issue number' }
      }
      if (!args.body?.trim()) {
        return { ok: false, error: 'Comment body required' }
      }
      return addIssueComment(repo.path, args.number, args.body.trim(), repo.issueSourcePreference)
    }
  )

  ipcMain.handle('gh:listLabels', (_event, args: { repoPath: string }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return listLabels(repo.path, repo.issueSourcePreference)
  })

  ipcMain.handle('gh:listAssignableUsers', (_event, args: { repoPath: string }) => {
    const repo = assertRegisteredRepo(args.repoPath, store)
    return listAssignableUsers(repo.path, repo.issueSourcePreference)
  })

  // Star operations target the Orca repo itself — no repoPath validation needed
  ipcMain.handle('gh:viewer', () => getAuthenticatedViewer())
  ipcMain.handle('gh:checkOrcaStarred', () => checkOrcaStarred())
  ipcMain.handle('gh:starOrca', () => starOrca())

  // ── Per-repo issue-source preference ───────────────────────────────
  // Why: explicit get/set is simpler than extending a generic repo-update
  // surface that does not yet exist. Read returns `'auto'` for unset repos so
  // the renderer never has to distinguish undefined from explicit-auto.
  ipcMain.handle(
    'gh:getIssueSourcePreference',
    (_event, args: { repoId: string }): IssueSourcePreference => {
      const repo = store.getRepo(args.repoId)
      return repo?.issueSourcePreference ?? 'auto'
    }
  )

  ipcMain.handle(
    'gh:setIssueSourcePreference',
    (_event, args: { repoId: string; preference: IssueSourcePreference }) => {
      const coerced = coerceIssueSourcePreference(args.preference)
      // Why: store `undefined` for 'auto' so the persisted record drops the key
      // entirely — matches the design-doc invariant that 'auto' and undefined
      // are treated identically and no stale explicit value is left on disk.
      const patch = coerced === 'auto' ? undefined : coerced
      store.updateRepo(args.repoId, { issueSourcePreference: patch })
    }
  )
}
