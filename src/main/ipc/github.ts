/* eslint-disable max-lines -- Why: all GitHub IPC handlers stay co-located so
the repo-path validation, preference-threading, and stats wiring patterns are
reviewable as one surface. Splitting by feature area would risk drifting
validation/gate conventions across handler files. */
import { ipcMain, webContents } from 'electron'
import { resolve } from 'path'
import type { Repo, GitHubIssueUpdate } from '../../shared/types'
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
  getWorkItemByOwnerRepo,
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
import { getRateLimit } from '../github/rate-limit'
import { diagnoseGhAuth } from '../github/auth-diagnose'
import type { GitHubPRFile } from '../../shared/types'
import { dispatchWorkItem, type WorkItemArgs } from './github-work-item-args'
import {
  getProjectViewTable,
  listAccessibleProjects,
  resolveProjectRef,
  listProjectViews,
  getWorkItemDetailsBySlug,
  updateProjectItemFieldValue,
  clearProjectItemFieldValue,
  updateIssueBySlug,
  updatePullRequestBySlug,
  addIssueCommentBySlug,
  updateIssueCommentBySlug,
  deleteIssueCommentBySlug,
  listLabelsBySlug,
  listAssignableUsersBySlug,
  listIssueTypesBySlug,
  updateIssueTypeBySlug
} from '../github/project-view'
import type {
  AddIssueCommentBySlugArgs,
  ClearProjectItemFieldArgs,
  DeleteIssueCommentBySlugArgs,
  GetProjectViewTableArgs,
  ListAssignableUsersBySlugArgs,
  ListIssueTypesBySlugArgs,
  ListLabelsBySlugArgs,
  ListProjectViewsArgs,
  ProjectWorkItemDetailsBySlugArgs,
  ResolveProjectRefArgs,
  UpdateIssueBySlugArgs,
  UpdateIssueCommentBySlugArgs,
  UpdateIssueTypeBySlugArgs,
  UpdateProjectItemFieldArgs,
  UpdatePullRequestBySlugArgs
} from '../../shared/github-project-types'

// Why: notify every renderer (each window has its own SWR cache instance)
// that a work item was mutated locally so they can drop their cached entry
// and refetch on the next open. Only emitted after a successful mutation.
// We skip the originating webContents because that renderer already updated
// its cache optimistically — re-broadcasting would race the optimistic write
// and erase it.
function broadcastWorkItemMutated(
  payload: {
    repoPath: string
    type: 'issue' | 'pr'
    number: number
  },
  senderId?: number
): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) {
      continue
    }
    if (senderId !== undefined && wc.id === senderId) {
      continue
    }
    wc.send('gh:workItemMutated', payload)
  }
}

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

export function registerGitHubHandlers(store: Store, stats: StatsCollector): void {
  ipcMain.handle(
    'gh:prForBranch',
    async (_event, args: { repoPath: string; branch: string; linkedPRNumber?: number | null }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      const pr = await getPRForBranch(repo.path, args.branch, args.linkedPRNumber ?? null)
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
    }
  )

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
  ipcMain.handle(
    'gh:workItemByOwnerRepo',
    (
      _event,
      args: {
        repoPath: string
        owner: string
        repo: string
        number: number
        type: 'issue' | 'pr'
      }
    ) =>
      getWorkItemByOwnerRepo(
        assertRegisteredRepo(args.repoPath, store).path,
        { owner: args.owner, repo: args.repo },
        args.number,
        args.type
      )
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
    async (_event, args: { repoPath: string; threadId: string; resolve: boolean }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      // Why: thread resolve doesn't carry the PR number, so we cannot target
      // a specific cache entry. The renderer cache stores per-(repo, type, number)
      // entries — emitting a path-wide invalidation here would require a new
      // event shape; instead, the drawer's existing thread-resolve UI updates
      // its local state immediately and the next reopen pays one fresh fetch.
      return resolveReviewThread(repo.path, args.threadId, args.resolve)
    }
  )

  ipcMain.handle(
    'gh:addPRReviewCommentReply',
    async (
      event,
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
      const result = await addPRReviewCommentReply(
        repo.path,
        args.prNumber,
        args.commentId,
        args.body.trim(),
        args.threadId,
        args.path,
        args.line
      )
      if (result.ok) {
        broadcastWorkItemMutated(
          { repoPath: repo.path, type: 'pr', number: args.prNumber },
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
      const result = await addPRReviewComment({
        repoPath: repo.path,
        prNumber: args.prNumber,
        commitId: args.commitId.trim(),
        path: args.path,
        line: args.line,
        startLine: args.startLine,
        body: args.body.trim()
      })
      if (result.ok) {
        broadcastWorkItemMutated(
          { repoPath: repo.path, type: 'pr', number: args.prNumber },
          event.sender.id
        )
      }
      return result
    }
  )

  ipcMain.handle(
    'gh:updatePRTitle',
    async (event, args: { repoPath: string; prNumber: number; title: string }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      const ok = await updatePRTitle(repo.path, args.prNumber, args.title)
      if (ok) {
        broadcastWorkItemMutated(
          { repoPath: repo.path, type: 'pr', number: args.prNumber },
          event.sender.id
        )
      }
      return ok
    }
  )

  ipcMain.handle(
    'gh:mergePR',
    async (
      event,
      args: { repoPath: string; prNumber: number; method?: 'merge' | 'squash' | 'rebase' }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      const result = await mergePR(repo.path, args.prNumber, args.method)
      if (result.ok) {
        broadcastWorkItemMutated(
          { repoPath: repo.path, type: 'pr', number: args.prNumber },
          event.sender.id
        )
      }
      return result
    }
  )

  ipcMain.handle(
    'gh:updateIssue',
    async (event, args: { repoPath: string; number: number; updates: GitHubIssueUpdate }) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      if (typeof args.number !== 'number' || !Number.isInteger(args.number) || args.number < 1) {
        return { ok: false, error: 'Invalid issue number' }
      }
      if (!args.updates || typeof args.updates !== 'object') {
        return { ok: false, error: 'Updates object is required' }
      }
      const result = await updateIssue(repo.path, args.number, args.updates)
      if (result.ok) {
        broadcastWorkItemMutated(
          { repoPath: repo.path, type: 'issue', number: args.number },
          event.sender.id
        )
      }
      return result
    }
  )

  ipcMain.handle(
    'gh:addIssueComment',
    async (
      event,
      args: { repoPath: string; number: number; body: string; type?: 'issue' | 'pr' }
    ) => {
      const repo = assertRegisteredRepo(args.repoPath, store)
      if (typeof args.number !== 'number' || !Number.isInteger(args.number) || args.number < 1) {
        return { ok: false, error: 'Invalid issue number' }
      }
      if (!args.body?.trim()) {
        return { ok: false, error: 'Comment body required' }
      }
      const result = await addIssueComment(repo.path, args.number, args.body.trim())
      if (result.ok) {
        // Why: PR conversation comments hit `/issues/N/comments` too, but the
        // drawer's cache key uses type='pr'. The caller passes through which
        // drawer they're posting from so we only invalidate the matching key
        // — broadcasting both would evict an unrelated PR/issue that happens
        // to share the number.
        broadcastWorkItemMutated(
          { repoPath: repo.path, type: args.type ?? 'issue', number: args.number },
          event.sender.id
        )
      }
      return result
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

  // Why: `rate_limit` is exempt from GitHub's rate-limit accounting, so
  // polling is cheap. A 30s in-process cache still avoids the gh subprocess
  // cost on every render — see getRateLimit for the ttl rationale. Force
  // parameter lets the renderer bust the cache after a known-expensive op
  // (e.g. post-ProjectPicker discovery) without waiting out the ttl.
  ipcMain.handle('gh:rateLimit', (_event, args?: { force?: boolean }) =>
    getRateLimit(args?.force ? { force: true } : undefined)
  )

  ipcMain.handle('gh:diagnoseAuth', () => diagnoseGhAuth())

  // ── GitHub ProjectV2 view handlers ─────────────────────────────────
  // Why: registered unconditionally so enabling the experimental flag at
  // runtime takes effect without a restart. The renderer gates entry points.
  // Handlers never throw across IPC — every failure mode resolves through the
  // GitHubProjectViewError envelope.

  ipcMain.handle('gh:listAccessibleProjects', () => listAccessibleProjects())

  ipcMain.handle('gh:resolveProjectRef', (_event, args: ResolveProjectRefArgs) =>
    resolveProjectRef(args)
  )

  ipcMain.handle('gh:listProjectViews', (_event, args: ListProjectViewsArgs) =>
    listProjectViews(args)
  )

  ipcMain.handle('gh:getProjectViewTable', (_event, args: GetProjectViewTableArgs) =>
    getProjectViewTable(args)
  )

  ipcMain.handle(
    'gh:projectWorkItemDetailsBySlug',
    (_event, args: ProjectWorkItemDetailsBySlugArgs) => getWorkItemDetailsBySlug(args)
  )

  ipcMain.handle('gh:updateProjectItemField', (_event, args: UpdateProjectItemFieldArgs) =>
    updateProjectItemFieldValue(args)
  )

  ipcMain.handle('gh:clearProjectItemField', (_event, args: ClearProjectItemFieldArgs) =>
    clearProjectItemFieldValue(args)
  )

  ipcMain.handle('gh:updateIssueBySlug', (_event, args: UpdateIssueBySlugArgs) =>
    updateIssueBySlug(args)
  )

  ipcMain.handle('gh:updatePullRequestBySlug', (_event, args: UpdatePullRequestBySlugArgs) =>
    updatePullRequestBySlug(args)
  )

  ipcMain.handle('gh:addIssueCommentBySlug', (_event, args: AddIssueCommentBySlugArgs) =>
    addIssueCommentBySlug(args)
  )

  ipcMain.handle('gh:updateIssueCommentBySlug', (_event, args: UpdateIssueCommentBySlugArgs) =>
    updateIssueCommentBySlug(args)
  )

  ipcMain.handle('gh:deleteIssueCommentBySlug', (_event, args: DeleteIssueCommentBySlugArgs) =>
    deleteIssueCommentBySlug(args)
  )

  ipcMain.handle('gh:listLabelsBySlug', (_event, args: ListLabelsBySlugArgs) =>
    listLabelsBySlug(args)
  )

  ipcMain.handle('gh:listAssignableUsersBySlug', (_event, args: ListAssignableUsersBySlugArgs) =>
    listAssignableUsersBySlug(args)
  )

  ipcMain.handle('gh:listIssueTypesBySlug', (_event, args: ListIssueTypesBySlugArgs) =>
    listIssueTypesBySlug(args)
  )

  ipcMain.handle('gh:updateIssueTypeBySlug', (_event, args: UpdateIssueTypeBySlugArgs) =>
    updateIssueTypeBySlug(args)
  )

  // Why: issue-source preference writes go through the generic `repos:update`
  // IPC (extended in this PR to accept `issueSourcePreference`). Routing
  // through the same channel keeps a single write path, guarantees the
  // `repos:changed` broadcast is emitted, and avoids two channels racing to
  // persist the same field with different validation and eviction semantics.
  // Reads piggyback on the `Repo` record already delivered by `repos:list`.
}
