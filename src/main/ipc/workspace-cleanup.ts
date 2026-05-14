/* eslint-disable max-lines */
import { ipcMain } from 'electron'
import { basename } from 'node:path'
import type { Store } from '../persistence'
import { getStatus, getBranchCompare } from '../git/status'
import { listRepoWorktrees, createFolderWorktree } from '../repo-worktrees'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import type { IGitProvider } from '../providers/types'
import { isFolderRepo } from '../../shared/repo-kind'
import type { GitStatusResult, GitWorktreeInfo, PRInfo, Repo, Worktree } from '../../shared/types'
import { mergeWorktree } from './worktree-logic'
import { splitWorktreeId } from '../../shared/worktree-id'
import {
  WORKSPACE_CLEANUP_ARCHIVED_IDLE_MS,
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
  WORKSPACE_CLEANUP_IDLE_MS,
  applyWorkspaceCleanupPolicy,
  createWorkspaceCleanupFingerprint,
  hasWorkspaceCleanupDivergenceProof,
  type WorkspaceCleanupBlocker,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupDismissArgs,
  type WorkspaceCleanupReason,
  type WorkspaceCleanupScanArgs,
  type WorkspaceCleanupScanResult
} from '../../shared/workspace-cleanup'

const GIT_READ_TIMEOUT_MS = 8_000
const WORKTREE_SCAN_CONCURRENCY = 3
const GITHUB_PR_CACHE_TTL_MS = 5 * 60_000

type PrCacheHit = {
  pr: PRInfo | null
  fetchedAt: number
  trustedForReady: boolean
  stale: boolean
}

type GitEvidence = {
  clean: boolean | null
  upstreamAhead: number | null
  upstreamBehind: number | null
  branchCompareChangedFiles: number | null
  checkedAt: number | null
  blockers: WorkspaceCleanupBlocker[]
}

export function registerWorkspaceCleanupHandlers(store: Store): void {
  ipcMain.removeHandler('workspaceCleanup:scan')
  ipcMain.removeHandler('workspaceCleanup:dismiss')
  ipcMain.removeHandler('workspaceCleanup:clearDismissals')

  ipcMain.handle(
    'workspaceCleanup:scan',
    (_event, args?: WorkspaceCleanupScanArgs): Promise<WorkspaceCleanupScanResult> =>
      scanWorkspaceCleanup(store, args ?? {})
  )

  ipcMain.handle('workspaceCleanup:dismiss', (_event, args: WorkspaceCleanupDismissArgs) => {
    const current = store.getUI().workspaceCleanup?.dismissals ?? {}
    const next = { ...current }
    for (const dismissal of args.dismissals ?? []) {
      if (
        dismissal &&
        dismissal.classifierVersion === WORKSPACE_CLEANUP_CLASSIFIER_VERSION &&
        typeof dismissal.worktreeId === 'string' &&
        typeof dismissal.fingerprint === 'string'
      ) {
        next[dismissal.worktreeId] = dismissal
      }
    }
    store.updateUI({ workspaceCleanup: { dismissals: next } })
  })

  ipcMain.handle('workspaceCleanup:clearDismissals', () => {
    store.updateUI({ workspaceCleanup: { dismissals: {} } })
  })
}

export async function scanWorkspaceCleanup(
  store: Store,
  args: WorkspaceCleanupScanArgs = {}
): Promise<WorkspaceCleanupScanResult> {
  const scannedAt = Date.now()
  const repos = store.getRepos()
  const duplicateRepoPaths = findDuplicateRepoPaths(repos)
  const errors: WorkspaceCleanupScanResult['errors'] = []
  const candidates: WorkspaceCleanupCandidate[] = []

  for (const repo of repos) {
    const result = await scanRepoWorkspaces({
      store,
      repo,
      scannedAt,
      duplicateRepoPaths,
      targetWorktreeId: args.worktreeId
    })
    candidates.push(...result.candidates)
    errors.push(...result.errors)
  }

  return { scannedAt, candidates, errors }
}

async function scanRepoWorkspaces(args: {
  store: Store
  repo: Repo
  scannedAt: number
  duplicateRepoPaths: Set<string>
  targetWorktreeId?: string
}): Promise<WorkspaceCleanupScanResult> {
  const { store, repo, scannedAt, duplicateRepoPaths, targetWorktreeId } = args
  const errors: WorkspaceCleanupScanResult['errors'] = []
  let provider: IGitProvider | null = null
  let gitWorktrees: GitWorktreeInfo[] = []
  const repoIsFolder = isFolderRepo(repo)

  try {
    if (repoIsFolder) {
      gitWorktrees = [createFolderWorktree(repo)]
    } else if (repo.connectionId) {
      provider = getSshGitProvider(repo.connectionId) ?? null
      if (!provider) {
        errors.push({ repoId: repo.id, message: 'SSH provider is unavailable.' })
        return {
          scannedAt,
          candidates: synthesizeDisconnectedSshCandidates(store, repo, scannedAt, targetWorktreeId),
          errors
        }
      }
      gitWorktrees = await withTimeout(
        provider.listWorktrees(repo.path),
        GIT_READ_TIMEOUT_MS,
        'Timed out listing SSH worktrees.'
      )
    } else {
      gitWorktrees = await withTimeout(
        listRepoWorktrees(repo),
        GIT_READ_TIMEOUT_MS,
        'Timed out listing worktrees.'
      )
    }
  } catch (error) {
    console.error('Workspace cleanup repo scan failed', error)
    errors.push({ repoId: repo.id, message: toSafeWorkspaceCleanupError(error) })
    return { scannedAt, candidates: [], errors }
  }

  const worktrees = gitWorktrees
    .map((gitWorktree) => {
      const worktreeId = `${repo.id}::${gitWorktree.path}`
      const meta = store.getWorktreeMeta(worktreeId)
      return mergeWorktree(repo.id, gitWorktree, meta, repo.displayName)
    })
    .filter((worktree) => !targetWorktreeId || worktree.id === targetWorktreeId)

  const candidates = await mapWithConcurrency(worktrees, WORKTREE_SCAN_CONCURRENCY, (worktree) =>
    buildCandidate({
      store,
      repo,
      worktree,
      scannedAt,
      provider,
      prCacheAmbiguous: Boolean(repo.connectionId) || duplicateRepoPaths.has(repo.path)
    }).catch((error) => {
      console.error('Workspace cleanup candidate scan failed', error)
      errors.push({ repoId: repo.id, message: toSafeWorkspaceCleanupError(error) })
      return buildCandidateFromError(repo, worktree, scannedAt, toErrorMessage(error))
    })
  )

  return { scannedAt, candidates, errors }
}

async function buildCandidate(args: {
  store: Store
  repo: Repo
  worktree: Worktree
  scannedAt: number
  provider: IGitProvider | null
  prCacheAmbiguous: boolean
}): Promise<WorkspaceCleanupCandidate> {
  const { store, repo, worktree, scannedAt, provider, prCacheAmbiguous } = args
  const blockers: WorkspaceCleanupBlocker[] = []
  const reasons: WorkspaceCleanupReason[] = []
  const repoIsFolder = isFolderRepo(repo)

  if (worktree.isMainWorktree) {
    blockers.push('main-worktree')
  }
  if (repoIsFolder) {
    blockers.push('folder-repo')
  }
  if (worktree.isPinned) {
    blockers.push('pinned')
  }

  const rawPrHit = findCachedPR(
    store,
    repo,
    shortBranchName(worktree.branch),
    worktree.linkedPR,
    scannedAt
  )
  const prHit = rawPrHit
    ? {
        ...rawPrHit,
        trustedForReady: rawPrHit.trustedForReady && !rawPrHit.stale && !prCacheAmbiguous
      }
    : null
  const linkedPR = prHit?.pr
    ? { number: prHit.pr.number, state: prHit.pr.state }
    : worktree.linkedPR !== null
      ? { number: worktree.linkedPR, state: 'unknown' as const }
      : undefined

  if (prHit?.pr?.state === 'open' || prHit?.pr?.state === 'draft') {
    blockers.push('open-pr')
  }

  const gitEvidence =
    repoIsFolder || worktree.isMainWorktree
      ? createEmptyGitEvidence()
      : await readGitEvidence(worktree, repo, provider)
  blockers.push(...gitEvidence.blockers)

  const localContext = buildLocalContext(worktree)
  const candidateWithoutFingerprint: WorkspaceCleanupCandidate = {
    worktreeId: worktree.id,
    repoId: repo.id,
    repoName: repo.displayName,
    connectionId: repo.connectionId ?? null,
    displayName: worktree.displayName,
    branch: shortBranchName(worktree.branch),
    path: worktree.path,
    tier: 'review',
    selectedByDefault: false,
    reasons,
    blockers: uniqueBlockers(blockers),
    lastActivityAt: worktree.lastActivityAt,
    ...(worktree.createdAt !== undefined ? { createdAt: worktree.createdAt } : {}),
    ...(linkedPR ? { linkedPR } : {}),
    localContext,
    git: {
      clean: gitEvidence.clean,
      upstreamAhead: gitEvidence.upstreamAhead,
      upstreamBehind: gitEvidence.upstreamBehind,
      branchCompareChangedFiles: gitEvidence.branchCompareChangedFiles,
      checkedAt: gitEvidence.checkedAt
    },
    prStateCheckedAt: prHit?.fetchedAt ?? null,
    staleEvidence: rawPrHit?.stale ?? false,
    fingerprint: ''
  }

  if (prHit?.trustedForReady && prHit.pr?.state === 'merged') {
    reasons.push('pr-merged')
  }
  if (
    prHit?.trustedForReady &&
    prHit.pr?.state === 'closed' &&
    gitEvidence.branchCompareChangedFiles === 0
  ) {
    reasons.push('pr-closed-clean')
  }
  if (
    worktree.isArchived &&
    scannedAt - worktree.lastActivityAt >= WORKSPACE_CLEANUP_ARCHIVED_IDLE_MS
  ) {
    reasons.push('archived')
  }
  const hasIdleOnlyLocalContext =
    localContext.diffCommentCount > 0 &&
    !(
      prHit?.trustedForReady &&
      (prHit.pr?.state === 'merged' ||
        (prHit.pr?.state === 'closed' && gitEvidence.branchCompareChangedFiles === 0))
    ) &&
    gitEvidence.branchCompareChangedFiles !== 0
  const linkedPrStateCanMakeIdleReady =
    worktree.linkedPR === null || prHit?.trustedForReady === true

  if (
    scannedAt - worktree.lastActivityAt >= WORKSPACE_CLEANUP_IDLE_MS &&
    !worktree.linkedIssue &&
    prHit?.pr?.state !== 'open' &&
    prHit?.pr?.state !== 'draft' &&
    linkedPR?.state !== 'unknown' &&
    linkedPrStateCanMakeIdleReady &&
    !hasIdleOnlyLocalContext &&
    hasWorkspaceCleanupDivergenceProof(candidateWithoutFingerprint)
  ) {
    reasons.push('idle-clean')
  }

  const fingerprint = createWorkspaceCleanupFingerprint({
    branch: candidateWithoutFingerprint.branch,
    head: worktree.head,
    prState: linkedPR?.state ?? null,
    gitClean: gitEvidence.clean,
    lastActivityAt: worktree.lastActivityAt
  })

  return applyWorkspaceCleanupPolicy({
    ...candidateWithoutFingerprint,
    reasons: uniqueReasons(reasons),
    blockers: uniqueBlockers(blockers),
    fingerprint
  })
}

async function readGitEvidence(
  worktree: Worktree,
  repo: Repo,
  provider: IGitProvider | null
): Promise<GitEvidence> {
  const blockers: WorkspaceCleanupBlocker[] = []
  let status: GitStatusResult
  let checkedAt = Date.now()

  try {
    status = await withTimeout(
      repo.connectionId ? provider!.getStatus(worktree.path) : getStatus(worktree.path),
      GIT_READ_TIMEOUT_MS,
      'Timed out reading git status.'
    )
  } catch {
    return {
      ...createEmptyGitEvidence(),
      blockers: ['git-status-error']
    }
  }

  if (status.upstreamStatus === undefined) {
    return {
      ...createEmptyGitEvidence(),
      blockers: ['git-status-error']
    }
  }

  const clean = status.entries.length === 0
  if (!clean) {
    blockers.push('dirty-files')
  }

  const upstreamAhead = status.upstreamStatus.hasUpstream ? status.upstreamStatus.ahead : null
  const upstreamBehind = status.upstreamStatus.hasUpstream ? status.upstreamStatus.behind : null
  if (upstreamAhead !== null && upstreamAhead > 0) {
    blockers.push('unpushed-commits')
  }

  let branchCompareChangedFiles: number | null = null
  if (worktree.baseRef) {
    try {
      const compare = await withTimeout(
        repo.connectionId
          ? provider!.getBranchCompare(worktree.path, worktree.baseRef)
          : getBranchCompare(worktree.path, worktree.baseRef),
        GIT_READ_TIMEOUT_MS,
        'Timed out comparing branch to base.'
      )
      if (compare.summary.status === 'ready') {
        branchCompareChangedFiles = compare.summary.changedFiles
        checkedAt = Date.now()
      }
    } catch {
      // Missing compare keeps the row visible but cannot make it ready.
    }
  }

  const evidence: GitEvidence = {
    clean,
    upstreamAhead,
    upstreamBehind,
    branchCompareChangedFiles,
    checkedAt,
    blockers
  }

  if (!hasWorkspaceCleanupDivergenceProof({ git: evidence })) {
    blockers.push('unknown-base')
  }

  return { ...evidence, blockers: uniqueBlockers(blockers) }
}

function buildCandidateFromError(
  repo: Repo,
  worktree: Worktree,
  scannedAt: number,
  _message: string
): WorkspaceCleanupCandidate {
  return applyWorkspaceCleanupPolicy({
    worktreeId: worktree.id,
    repoId: repo.id,
    repoName: repo.displayName,
    connectionId: repo.connectionId ?? null,
    displayName: worktree.displayName,
    branch: shortBranchName(worktree.branch),
    path: worktree.path,
    tier: 'protected',
    selectedByDefault: false,
    reasons: [],
    blockers: ['git-status-error'],
    lastActivityAt: worktree.lastActivityAt,
    ...(worktree.createdAt !== undefined ? { createdAt: worktree.createdAt } : {}),
    localContext: buildLocalContext(worktree),
    git: {
      clean: null,
      upstreamAhead: null,
      upstreamBehind: null,
      branchCompareChangedFiles: null,
      checkedAt: scannedAt
    },
    prStateCheckedAt: null,
    staleEvidence: false,
    fingerprint: createWorkspaceCleanupFingerprint({
      branch: shortBranchName(worktree.branch),
      head: worktree.head,
      prState: null,
      gitClean: null,
      lastActivityAt: worktree.lastActivityAt
    })
  })
}

function synthesizeDisconnectedSshCandidates(
  store: Store,
  repo: Repo,
  scannedAt: number,
  targetWorktreeId?: string
): WorkspaceCleanupCandidate[] {
  return Object.entries(store.getAllWorktreeMeta())
    .filter(([worktreeId]) => {
      if (!worktreeId.startsWith(`${repo.id}::`)) {
        return false
      }
      return !targetWorktreeId || targetWorktreeId === worktreeId
    })
    .map(([worktreeId, meta]) => {
      const parsed = splitWorktreeId(worktreeId)
      const path = parsed?.worktreePath ?? worktreeId
      return applyWorkspaceCleanupPolicy({
        worktreeId,
        repoId: repo.id,
        repoName: repo.displayName,
        connectionId: repo.connectionId ?? null,
        displayName: meta.displayName || basename(path),
        branch: basename(path),
        path,
        tier: 'protected',
        selectedByDefault: false,
        reasons:
          meta.isArchived && scannedAt - meta.lastActivityAt >= WORKSPACE_CLEANUP_ARCHIVED_IDLE_MS
            ? ['archived']
            : [],
        blockers: ['ssh-disconnected'],
        lastActivityAt: meta.lastActivityAt,
        ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
        localContext: {
          terminalTabCount: 0,
          cleanEditorTabCount: 0,
          browserTabCount: 0,
          diffCommentCount: meta.diffComments?.length ?? 0,
          newestDiffCommentAt: getNewestDiffCommentAt(meta.diffComments),
          retainedDoneAgentCount: 0
        },
        git: {
          clean: null,
          upstreamAhead: null,
          upstreamBehind: null,
          branchCompareChangedFiles: null,
          checkedAt: null
        },
        prStateCheckedAt: null,
        staleEvidence: false,
        fingerprint: createWorkspaceCleanupFingerprint({
          branch: basename(path),
          head: '',
          prState: null,
          gitClean: null,
          lastActivityAt: meta.lastActivityAt
        })
      })
    })
}

function findCachedPR(
  store: Store,
  repo: Repo,
  branch: string,
  linkedPR: number | null,
  now: number
): PrCacheHit | null {
  const cache = store.getGitHubCache().pr
  const exact = cache[`${repo.path}::${branch}`]
  if (exact) {
    return {
      pr: exact.data,
      fetchedAt: exact.fetchedAt,
      trustedForReady: true,
      stale: isPrCacheStale(exact.fetchedAt, now)
    }
  }

  if (!linkedPR) {
    return null
  }

  const repoPrefix = `${repo.path}::`
  for (const [key, value] of Object.entries(cache)) {
    if (key.startsWith(repoPrefix) && value.data?.number === linkedPR) {
      return {
        pr: value.data,
        fetchedAt: value.fetchedAt,
        trustedForReady: true,
        stale: isPrCacheStale(value.fetchedAt, now)
      }
    }
  }

  return null
}

function isPrCacheStale(fetchedAt: number, now: number): boolean {
  return now - fetchedAt >= GITHUB_PR_CACHE_TTL_MS
}

function buildLocalContext(worktree: Worktree): WorkspaceCleanupCandidate['localContext'] {
  return {
    terminalTabCount: 0,
    cleanEditorTabCount: 0,
    browserTabCount: 0,
    diffCommentCount: worktree.diffComments?.length ?? 0,
    newestDiffCommentAt: getNewestDiffCommentAt(worktree.diffComments),
    retainedDoneAgentCount: 0
  }
}

function getNewestDiffCommentAt(diffComments: Worktree['diffComments'] | undefined): number | null {
  if (!diffComments || diffComments.length === 0) {
    return null
  }
  return Math.max(...diffComments.map((comment) => comment.createdAt))
}

function createEmptyGitEvidence(): GitEvidence {
  return {
    clean: null,
    upstreamAhead: null,
    upstreamBehind: null,
    branchCompareChangedFiles: null,
    checkedAt: null,
    blockers: []
  }
}

function shortBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '') || 'HEAD'
}

function uniqueBlockers(blockers: WorkspaceCleanupBlocker[]): WorkspaceCleanupBlocker[] {
  return [...new Set(blockers)]
}

function uniqueReasons(reasons: WorkspaceCleanupReason[]): WorkspaceCleanupReason[] {
  return [...new Set(reasons)]
}

function findDuplicateRepoPaths(repos: Repo[]): Set<string> {
  const counts = new Map<string, number>()
  for (const repo of repos) {
    counts.set(repo.path, (counts.get(repo.path) ?? 0) + 1)
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([path]) => path))
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = []
  let nextIndex = 0
  const workerCount = Math.min(limit, items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await fn(items[index])
      }
    })
  )
  return results
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toSafeWorkspaceCleanupError(error: unknown): string {
  const message = toErrorMessage(error)
  if (message.startsWith('Timed out ')) {
    return message
  }
  return 'Could not scan workspace cleanup for this repository.'
}
