/* eslint-disable max-lines -- Why: all GitHub IPC handlers stay co-located so
the repo-path validation, preference-threading, and stats wiring patterns are
reviewable as one surface. Splitting by feature area would risk drifting
validation/gate conventions across handler files. */
import { ipcMain, webContents } from 'electron'
import { resolve } from 'node:path'
import type {
  Repo,
  GitHubCreateIssueFields,
  GitHubIssueUpdate,
  GitHubOwnerRepo,
  GitHubPullRequestStateUpdate,
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEnqueueResult,
  GitHubPRRefreshReason,
  PRRefreshOutcome
} from '../../shared/types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type { TaskSourceContext } from '../../shared/task-source-context'
import type { Store } from '../persistence'
import type { StatsCollector } from '../stats/collector'
import {
  getPRForBranch,
  getIssue,
  getRepoSlug,
  getRepoUpstream,
  listIssues,
  listWorkItems,
  countWorkItems,
  getWorkItem,
  getWorkItemByOwnerRepo,
  createIssue,
  updateIssue,
  addIssueComment,
  enableRepoIssues,
  listLabels,
  listAssignableUsers,
  getAuthenticatedViewer,
  getPRChecks,
  getPRCheckDetails,
  getPRComments,
  resolveReviewThread,
  setPRFileViewed,
  addPRReviewComment,
  addPRReviewCommentReply,
  updatePRTitle,
  mergePR,
  setPRAutoMerge,
  updatePRState,
  rerunPRChecks,
  requestPRReviewers,
  removePRReviewers,
  checkOrcaStarred,
  starOrca
} from '../github/client'
import type { GitHubPRBranchLookupOptions } from '../github/client'
import {
  clearVisiblePRRefreshWindow,
  enqueuePRRefresh,
  refreshPRNow,
  reportVisiblePRRefreshCandidates,
  setPRRefreshOutcomeObserver
} from '../github/pr-refresh-coordinator'
import { getWorkItemDetails, getPRFileContents } from '../github/work-item-details'
import { getRateLimit } from '../github/rate-limit'
import { diagnoseGhAuth } from '../github/auth-diagnose'
import {
  notePRRefreshValidationDenial,
  type PRRefreshValidationDenialReason
} from '../github/pr-refresh-validation-backoff'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import type { GitHubPRFile } from '../../shared/types'
import { dispatchWorkItem, type WorkItemArgs } from './github-work-item-args'
import { getViewerRepoPermission } from '../github/viewer-repo-permission'
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
import { appStarSourceSchema } from '../../shared/gh-star-source'
import { track } from '../telemetry/client'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'

const prRefreshVisibilityCleanupRegistered = new Set<number>()

// Why: notify every renderer (each window has its own SWR cache instance)
// that a work item was mutated locally so they can drop their cached entry
// and refetch on the next open. Only emitted after a successful mutation.
// We skip the originating webContents because that renderer already updated
// its cache optimistically — re-broadcasting would race the optimistic write
// and erase it.
function broadcastWorkItemMutated(
  payload: {
    repoPath: string
    repoId?: string
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
type RepoScopedArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

type RegisteredRepoValidationResult =
  | { kind: 'ok'; repo: Repo }
  | { kind: 'denied'; reason: PRRefreshValidationDenialReason; message: string }

function validateRegisteredRepo(
  args: string | RepoScopedArgs,
  store: Store,
  repos = store.getRepos()
): RegisteredRepoValidationResult {
  const repoPath = typeof args === 'string' ? args : args.repoPath
  const repoId = typeof args === 'string' ? undefined : args.repoId
  const resolvedRepoPath = resolve(repoPath)
  const repo = repos.find((r) => (repoId ? r.id === repoId : resolve(r.path) === resolvedRepoPath))
  if (!repo) {
    return {
      kind: 'denied',
      reason: 'unknown-repo',
      message: 'Access denied: unknown repository path'
    }
  }
  if (repoId && resolve(repo.path) !== resolvedRepoPath) {
    return {
      kind: 'denied',
      reason: 'repo-path-mismatch',
      message: 'Access denied: repository path does not match repo id'
    }
  }
  if (
    typeof args !== 'string' &&
    args.sourceContext?.provider === 'github' &&
    args.sourceContext.hostId !== getRepoExecutionHostId(repo)
  ) {
    return {
      kind: 'denied',
      reason: 'host-mismatch',
      message: 'Access denied: GitHub source host does not match repository host'
    }
  }
  return { kind: 'ok', repo }
}

function assertRegisteredRepo(args: string | RepoScopedArgs, store: Store): Repo {
  const result = validateRegisteredRepo(args, store)
  if (result.kind === 'denied') {
    throw new Error(result.message)
  }
  return result.repo
}

function repoConnectionId(repo: Repo): string | null {
  return repo.connectionId ?? null
}

function localGitOptionArgs(store: Store, repo: Repo): [] | [{ wslDistro?: string }] {
  const localGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  return Object.keys(localGitOptions).length > 0 ? [localGitOptions] : []
}

function applyRepoToPRRefreshCandidate(
  store: Store,
  repo: Repo,
  candidate: GitHubPRRefreshCandidate
): GitHubPRRefreshCandidate {
  const localGitOptions = localGitOptionArgs(store, repo)[0]
  const appliedCandidate = { ...candidate }
  delete appliedCandidate.localGitOptions
  delete appliedCandidate.connectionId
  delete appliedCandidate.executionHostId
  delete appliedCandidate.connectionState
  return {
    ...appliedCandidate,
    repoPath: repo.path,
    repoId: repo.id,
    ...(localGitOptions ? { localGitOptions } : {}),
    connectionId: repoConnectionId(repo),
    executionHostId: repo.executionHostId ?? null,
    connectionState: repo.connectionId ? 'connected' : 'unknown'
  }
}

function validateAutomaticPRRefreshCandidate(
  candidate: GitHubPRRefreshCandidate,
  store: Store,
  repos = store.getRepos()
):
  | { kind: 'ok'; candidate: GitHubPRRefreshCandidate }
  | {
      kind: 'skipped'
      result: Extract<GitHubPRRefreshEnqueueResult, { kind: 'skipped' }>
    } {
  const result = validateRegisteredRepo(candidate, store, repos)
  if (result.kind === 'denied') {
    const skippedReason = notePRRefreshValidationDenial({
      repoId: candidate.repoId,
      repoPath: candidate.repoPath,
      reason: result.reason
    })
    return { kind: 'skipped', result: { kind: 'skipped', skippedReason } }
  }
  return { kind: 'ok', candidate: applyRepoToPRRefreshCandidate(store, result.repo, candidate) }
}

export function registerGitHubHandlers(store: Store, stats: StatsCollector): void {
  function recordPRIfNeeded(repo: Repo, outcome: PRRefreshOutcome): void {
    if (outcome.kind === 'found' && !stats.hasCountedPR(outcome.pr.url)) {
      stats.record({
        type: 'pr_created',
        at: Date.now(),
        repoId: repo.id,
        meta: { prNumber: outcome.pr.number, prUrl: outcome.pr.url }
      })
    }
  }

  setPRRefreshOutcomeObserver((candidate, outcome) => {
    const repo =
      store.getRepos().find((r) => r.id === candidate.repoId) ??
      store.getRepos().find((r) => resolve(r.path) === resolve(candidate.repoPath))
    if (repo) {
      recordPRIfNeeded(repo, outcome)
    }
  })

  ipcMain.handle(
    'gh:prForBranch',
    async (
      _event,
      args: {
        repoPath: string
        branch: string
        linkedPRNumber?: number | null
        fallbackPRNumber?: number | null
        acceptMergedFallbackPR?: boolean
        currentHeadOid?: string | null
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      const localGitOptions = localGitOptionArgs(store, repo)[0]
      const hostedReviewOptionArgs: [] | [{ localGitExecOptions: { wslDistro?: string } }] =
        localGitOptions ? [{ localGitExecOptions: localGitOptions }] : []
      const currentHeadOid =
        typeof args.currentHeadOid === 'string' && args.currentHeadOid.trim().length > 0
          ? args.currentHeadOid.trim()
          : null
      const lookupOptions: GitHubPRBranchLookupOptions | undefined = hostedReviewOptionArgs[0]
        ? { ...hostedReviewOptionArgs[0] }
        : args.acceptMergedFallbackPR === true || currentHeadOid !== null
          ? {}
          : undefined
      if (lookupOptions && args.acceptMergedFallbackPR === true) {
        lookupOptions.acceptMergedFallbackPR = true
      }
      if (lookupOptions && currentHeadOid !== null) {
        lookupOptions.currentHeadOid = currentHeadOid
      }
      const lookupOptionArgs: [] | [GitHubPRBranchLookupOptions] = lookupOptions
        ? [lookupOptions]
        : []
      const pr = await getPRForBranch(
        repo.path,
        args.branch,
        args.linkedPRNumber ?? null,
        repoConnectionId(repo),
        args.linkedPRNumber == null ? (args.fallbackPRNumber ?? null) : null,
        ...lookupOptionArgs
      )
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

  ipcMain.handle(
    'gh:refreshPRNow',
    async (_event, args: { candidate: GitHubPRRefreshCandidate }) => {
      const repo = assertRegisteredRepo(args.candidate, store)
      const outcome = await refreshPRNow(applyRepoToPRRefreshCandidate(store, repo, args.candidate))
      recordPRIfNeeded(repo, outcome)
      return outcome
    }
  )

  ipcMain.handle(
    'gh:enqueuePRRefresh',
    (
      event,
      args: {
        candidate: GitHubPRRefreshCandidate
        reason: GitHubPRRefreshReason
        priority?: number
      }
    ): GitHubPRRefreshEnqueueResult => {
      const validation = validateAutomaticPRRefreshCandidate(args.candidate, store)
      if (validation.kind === 'skipped') {
        return validation.result
      }
      const senderWindowId = event?.sender?.id
      enqueuePRRefresh(validation.candidate, args.reason, args.priority ?? 0, senderWindowId)
      return { kind: 'queued' }
    }
  )

  ipcMain.handle(
    'gh:reportVisiblePRRefreshCandidates',
    (event, args: { candidates: GitHubPRRefreshCandidate[]; generation: number }) => {
      const senderId = event.sender.id
      if (!prRefreshVisibilityCleanupRegistered.has(senderId)) {
        prRefreshVisibilityCleanupRegistered.add(senderId)
        event.sender.once('destroyed', () => {
          prRefreshVisibilityCleanupRegistered.delete(senderId)
          clearVisiblePRRefreshWindow(senderId)
        })
      }
      const candidates: GitHubPRRefreshCandidate[] = []
      const repos = store.getRepos()
      for (const candidate of args.candidates) {
        const validation = validateAutomaticPRRefreshCandidate(candidate, store, repos)
        if (validation.kind === 'ok') {
          candidates.push(validation.candidate)
        }
      }
      reportVisiblePRRefreshCandidates(candidates, args.generation, senderId)
      return true
    }
  )

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
      const repo = assertRegisteredRepo(args, store)
      return getIssue(
        repo.path,
        args.number,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle('gh:listIssues', (_event, args: { repoPath: string; limit?: number }) => {
    const repo = assertRegisteredRepo(args, store)
    // Why: listIssues now returns { items, error? }. The IPC handler unwraps to
    // the items array for the existing contract; feature 1's UI consumes the
    // richer envelope through `gh:listWorkItems` instead.
    return listIssues(
      repo.path,
      args.limit,
      repo.issueSourcePreference,
      repoConnectionId(repo),
      ...localGitOptionArgs(store, repo)
    ).then((r) => r.items)
  })

  ipcMain.handle(
    'gh:createIssue',
    (_event, args: RepoScopedArgs & { title: string; body: string } & GitHubCreateIssueFields) => {
      const repo = assertRegisteredRepo(args, store)
      const fields =
        args.labels !== undefined || args.assignees !== undefined
          ? { labels: args.labels, assignees: args.assignees }
          : undefined
      return createIssue(
        repo.path,
        args.title,
        args.body,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        fields,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gh:viewerRepoPermission',
    (_event, args: RepoScopedArgs & { owner?: string; repo?: string }) => {
      const repo = assertRegisteredRepo(args, store)
      const override = args.owner && args.repo ? { owner: args.owner, repo: args.repo } : null
      // Why: positional call — spreading the optional git-options tuple here
      // would shift `override` into the options slot when the tuple is empty.
      return getViewerRepoPermission(
        repo.path,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        localGitOptionArgs(store, repo)[0] ?? {},
        override
      )
    }
  )

  ipcMain.handle(
    'gh:enableRepoIssues',
    (_event, args: RepoScopedArgs & { owner: string; repo: string }) => {
      const repo = assertRegisteredRepo(args, store)
      return enableRepoIssues(
        repo.path,
        { owner: args.owner, repo: args.repo },
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
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
        before?: string
        noCache?: boolean
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return listWorkItems(
        repo.path,
        args.limit,
        args.query,
        args.before,
        repo.issueSourcePreference,
        repoConnectionId(repo),
        args.noCache,
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle('gh:countWorkItems', (_event, args: { repoPath: string; query?: string }) => {
    const repo = assertRegisteredRepo(args, store)
    return countWorkItems(
      repo.path,
      args.query,
      repo.issueSourcePreference,
      repoConnectionId(repo),
      ...localGitOptionArgs(store, repo)
    )
  })

  ipcMain.handle('gh:workItem', (_event, args: WorkItemArgs) => {
    const repo = assertRegisteredRepo(args, store)
    return dispatchWorkItem(args, repo, getWorkItem, localGitOptionArgs(store, repo)[0])
  })
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
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return getWorkItemByOwnerRepo(
        repo.path,
        { owner: args.owner, repo: args.repo },
        args.number,
        args.type,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )
  ipcMain.handle('gh:workItemDetails', (_event, args: WorkItemArgs) => {
    const repo = assertRegisteredRepo(args, store)
    return dispatchWorkItem(args, repo, getWorkItemDetails, localGitOptionArgs(store, repo)[0])
  })

  ipcMain.handle(
    'gh:notifyWorkItemMutated',
    (
      event,
      args: {
        repoPath: string
        repoId?: string
        type: 'issue' | 'pr'
        number: number
      }
    ) => {
      const repo = args.repoId
        ? store.getRepos().find((candidate) => candidate.id === args.repoId)
        : assertRegisteredRepo(args, store)
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
      broadcastWorkItemMutated(
        {
          repoPath: repo.path,
          repoId: repo.id,
          type: args.type,
          number: args.number
        },
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
        path: string
        oldPath?: string
        status: GitHubPRFile['status']
        headSha: string
        baseSha: string
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      return getPRFileContents({
        repoPath: repo.path,
        connectionId: repoConnectionId(repo),
        localGitOptions: localGitOptionArgs(store, repo)[0],
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
    const repo = assertRegisteredRepo(args, store)
    const localGitOptions = localGitOptionArgs(store, repo)[0]
    return localGitOptions
      ? getRepoSlug(repo.path, repoConnectionId(repo), { localGitExecOptions: localGitOptions })
      : getRepoSlug(repo.path, repoConnectionId(repo))
  })

  ipcMain.handle('gh:repoUpstream', (_event, args: { repoPath: string }) => {
    const repo = assertRegisteredRepo(args, store)
    const localGitOptions = localGitOptionArgs(store, repo)[0]
    return localGitOptions
      ? getRepoUpstream(repo.path, repoConnectionId(repo), { localGitExecOptions: localGitOptions })
      : getRepoUpstream(repo.path, repoConnectionId(repo))
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
      const repo = assertRegisteredRepo(args, store)
      return getPRChecks(
        repo.path,
        args.prNumber,
        args.headSha,
        args.prRepo ?? null,
        {
          noCache: args.noCache
        },
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
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
      const repo = assertRegisteredRepo(args, store)
      return getPRCheckDetails(
        repo.path,
        {
          checkRunId: args.checkRunId,
          workflowRunId: args.workflowRunId,
          checkName: args.checkName,
          url: args.url,
          prRepo: args.prRepo ?? null
        },
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
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
      const repo = assertRegisteredRepo(args, store)
      return getPRComments(
        repo.path,
        args.prNumber,
        { noCache: args.noCache, prRepo: args.prRepo ?? null },
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
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
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      // Why: thread resolve doesn't carry the PR number, so we cannot target
      // a specific cache entry. The renderer cache stores per-(repo, type, number)
      // entries — emitting a path-wide invalidation here would require a new
      // event shape; instead, the drawer's existing thread-resolve UI updates
      // its local state immediately and the next reopen pays one fresh fetch.
      return resolveReviewThread(
        repo.path,
        args.threadId,
        args.resolve,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gh:setPRFileViewed',
    async (
      event,
      args: {
        repoPath: string
        repoId?: string
        prNumber: number
        pullRequestId: string
        path: string
        viewed: boolean
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
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
        connectionId: repoConnectionId(repo),
        localGitOptions: localGitOptionArgs(store, repo)[0],
        pullRequestId: args.pullRequestId.trim(),
        path: args.path,
        viewed: Boolean(args.viewed)
      })
      if (ok) {
        broadcastWorkItemMutated(
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
      const repo = assertRegisteredRepo(args, store)
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
        repoConnectionId(repo),
        args.prRepo ?? null,
        ...localGitOptionArgs(store, repo)
      )
      if (result.ok) {
        broadcastWorkItemMutated(
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
        commitId: string
        path: string
        line: number
        startLine?: number
        body: string
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
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
        body: args.body.trim(),
        connectionId: repoConnectionId(repo),
        localGitOptions: localGitOptionArgs(store, repo)[0]
      })
      if (result.ok) {
        broadcastWorkItemMutated(
          { repoPath: repo.path, repoId: repo.id, type: 'pr', number: args.prNumber },
          event.sender.id
        )
      }
      return result
    }
  )

  ipcMain.handle(
    'gh:updatePRTitle',
    async (
      event,
      args: { repoPath: string; prNumber: number; title: string; prRepo?: GitHubOwnerRepo | null }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      const ok = await updatePRTitle(
        repo.path,
        args.prNumber,
        args.title,
        repoConnectionId(repo),
        args.prRepo ?? null,
        ...localGitOptionArgs(store, repo)
      )
      if (ok) {
        broadcastWorkItemMutated(
          { repoPath: repo.path, repoId: repo.id, type: 'pr', number: args.prNumber },
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
      args: {
        repoPath: string
        repoId?: string | null
        sourceContext?: TaskSourceContext | null
        prNumber: number
        method?: 'merge' | 'squash' | 'rebase'
        prRepo?: GitHubOwnerRepo | null
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      const result = await mergePR(
        repo.path,
        args.prNumber,
        args.method,
        repoConnectionId(repo),
        args.prRepo ?? null,
        ...localGitOptionArgs(store, repo)
      )
      if (result.ok) {
        broadcastWorkItemMutated(
          { repoPath: repo.path, repoId: repo.id, type: 'pr', number: args.prNumber },
          event.sender.id
        )
      }
      return result
    }
  )

  ipcMain.handle(
    'gh:setPRAutoMerge',
    async (
      event,
      args: {
        repoPath: string
        repoId?: string | null
        sourceContext?: TaskSourceContext | null
        prNumber: number
        enabled: boolean
        method?: 'merge' | 'squash' | 'rebase'
        prRepo?: GitHubOwnerRepo | null
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      const result = await setPRAutoMerge(
        repo.path,
        args.prNumber,
        args.enabled,
        args.method,
        repoConnectionId(repo),
        args.prRepo ?? null,
        ...localGitOptionArgs(store, repo)
      )
      if (result.ok) {
        broadcastWorkItemMutated(
          { repoPath: repo.path, repoId: repo.id, type: 'pr', number: args.prNumber },
          event.sender.id
        )
      }
      return result
    }
  )

  ipcMain.handle(
    'gh:updatePRState',
    async (
      event,
      args: RepoScopedArgs & { prNumber: number; updates: GitHubPullRequestStateUpdate }
    ) => {
      const repo = assertRegisteredRepo(args, store)
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
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
      if (result.ok) {
        broadcastWorkItemMutated(
          { repoPath: repo.path, repoId: repo.id, type: 'pr', number: args.prNumber },
          event.sender.id
        )
      }
      return result
    }
  )

  ipcMain.handle(
    'gh:rerunPRChecks',
    async (
      _event,
      args: RepoScopedArgs & { prNumber: number; headSha?: string; failedOnly?: boolean }
    ) => {
      const repo = assertRegisteredRepo(args, store)
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
        { headSha: args.headSha, failedOnly: args.failedOnly },
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
    }
  )

  ipcMain.handle(
    'gh:requestPRReviewers',
    async (event, args: RepoScopedArgs & { prNumber: number; reviewers: string[] }) => {
      const repo = assertRegisteredRepo(args, store)
      const result = await requestPRReviewers(
        repo.path,
        args.prNumber,
        args.reviewers,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
      if (result.ok) {
        broadcastWorkItemMutated(
          { repoPath: repo.path, repoId: repo.id, type: 'pr', number: args.prNumber },
          event.sender.id
        )
      }
      return result
    }
  )

  ipcMain.handle(
    'gh:removePRReviewers',
    async (event, args: RepoScopedArgs & { prNumber: number; reviewers: string[] }) => {
      const repo = assertRegisteredRepo(args, store)
      const result = await removePRReviewers(
        repo.path,
        args.prNumber,
        args.reviewers,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
      if (result.ok) {
        broadcastWorkItemMutated(
          { repoPath: repo.path, repoId: repo.id, type: 'pr', number: args.prNumber },
          event.sender.id
        )
      }
      return result
    }
  )

  ipcMain.handle(
    'gh:updateIssue',
    async (event, args: RepoScopedArgs & { number: number; updates: GitHubIssueUpdate }) => {
      const repo = assertRegisteredRepo(args, store)
      if (typeof args.number !== 'number' || !Number.isInteger(args.number) || args.number < 1) {
        return { ok: false, error: 'Invalid issue number' }
      }
      if (!args.updates || typeof args.updates !== 'object') {
        return { ok: false, error: 'Updates object is required' }
      }
      const result = await updateIssue(
        repo.path,
        args.number,
        args.updates,
        repoConnectionId(repo),
        ...localGitOptionArgs(store, repo)
      )
      if (result.ok) {
        broadcastWorkItemMutated(
          { repoPath: repo.path, repoId: repo.id, type: 'issue', number: args.number },
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
      args: {
        repoPath: string
        repoId?: string
        sourceContext?: TaskSourceContext | null
        number: number
        body: string
        type?: 'issue' | 'pr'
        prRepo?: GitHubOwnerRepo | null
      }
    ) => {
      const repo = assertRegisteredRepo(args, store)
      if (typeof args.number !== 'number' || !Number.isInteger(args.number) || args.number < 1) {
        return { ok: false, error: 'Invalid issue number' }
      }
      if (!args.body?.trim()) {
        return { ok: false, error: 'Comment body required' }
      }
      const result = await addIssueComment(
        repo.path,
        args.number,
        args.body.trim(),
        repoConnectionId(repo),
        args.prRepo ?? null,
        ...localGitOptionArgs(store, repo)
      )
      if (result.ok) {
        // Why: PR conversation comments hit `/issues/N/comments` too, but the
        // drawer's cache key uses type='pr'. The caller passes through which
        // drawer they're posting from so we only invalidate the matching key
        // — broadcasting both would evict an unrelated PR/issue that happens
        // to share the number.
        broadcastWorkItemMutated(
          { repoPath: repo.path, repoId: repo.id, type: args.type ?? 'issue', number: args.number },
          event.sender.id
        )
      }
      return result
    }
  )

  ipcMain.handle('gh:listLabels', (_event, args: RepoScopedArgs) => {
    const repo = assertRegisteredRepo(args, store)
    return listLabels(
      repo.path,
      repo.issueSourcePreference,
      repoConnectionId(repo),
      ...localGitOptionArgs(store, repo)
    )
  })

  ipcMain.handle('gh:listAssignableUsers', (_event, args: RepoScopedArgs) => {
    const repo = assertRegisteredRepo(args, store)
    return listAssignableUsers(
      repo.path,
      repo.issueSourcePreference,
      repoConnectionId(repo),
      ...localGitOptionArgs(store, repo)
    )
  })

  // Star operations target the Orca repo itself — no repoPath validation needed
  ipcMain.handle('gh:viewer', () => getAuthenticatedViewer())
  ipcMain.handle('gh:checkOrcaStarred', () => checkOrcaStarred())
  ipcMain.handle('gh:starOrca', async (_event, source: unknown) => {
    const sourceParse = appStarSourceSchema.safeParse(source)
    const starred = await starOrca()
    if (starred && sourceParse.success) {
      // Why: this main-owned event bypasses renderer telemetry IPC, so cohort
      // context must be attached here on the successful star path.
      track('app_starred_orca', {
        source: sourceParse.data,
        ...getCohortAtEmit()
      })
    }
    return starred
  })

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
