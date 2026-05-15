/* eslint-disable max-lines */
import { ipcMain } from 'electron'
import { basename } from 'node:path'
import type { Store } from '../persistence'
import { getStatus } from '../git/status'
import { gitExecFileAsync } from '../git/runner'
import { listRepoWorktrees, createFolderWorktree } from '../repo-worktrees'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import type { IGitProvider, IPtyProvider } from '../providers/types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { listRegisteredPtys } from '../memory/pty-registry'
import { getSshPtyProvider } from './pty'
import { isFolderRepo } from '../../shared/repo-kind'
import type { GitStatusResult, GitWorktreeInfo, Repo, Worktree } from '../../shared/types'
import { mergeWorktree } from './worktree-logic'
import { splitWorktreeId } from '../../shared/worktree-id'
import {
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
  applyWorkspaceCleanupPolicy,
  createWorkspaceCleanupFingerprint,
  getWorkspaceCleanupInactivityReasons,
  isWorkspaceOldForCleanup,
  type WorkspaceCleanupBlocker,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupDismissArgs,
  type WorkspaceCleanupLocalProcessArgs,
  type WorkspaceCleanupLocalProcessResult,
  type WorkspaceCleanupReason,
  type WorkspaceCleanupScanError,
  type WorkspaceCleanupScanArgs,
  type WorkspaceCleanupScanResult
} from '../../shared/workspace-cleanup'

const GIT_READ_TIMEOUT_MS = 8_000
const WORKTREE_SCAN_CONCURRENCY = 3

type GitEvidence = {
  clean: boolean | null
  upstreamAhead: number | null
  upstreamBehind: number | null
  checkedAt: number | null
  blockers: WorkspaceCleanupBlocker[]
}

type WorkspaceCleanupHandlerDeps = {
  runtime?: OrcaRuntimeService
  getLocalPtyProvider?: () => IPtyProvider
}

export function registerWorkspaceCleanupHandlers(
  store: Store,
  deps: WorkspaceCleanupHandlerDeps = {}
): void {
  ipcMain.removeHandler('workspaceCleanup:scan')
  ipcMain.removeHandler('workspaceCleanup:dismiss')
  ipcMain.removeHandler('workspaceCleanup:clearDismissals')
  ipcMain.removeHandler('workspaceCleanup:hasKillableLocalProcesses')

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

  ipcMain.handle(
    'workspaceCleanup:hasKillableLocalProcesses',
    async (
      _event,
      args: WorkspaceCleanupLocalProcessArgs
    ): Promise<WorkspaceCleanupLocalProcessResult> => ({
      hasKillableProcesses: await hasKillableProcesses(args, deps)
    })
  )
}

async function hasKillableProcesses(
  args: WorkspaceCleanupLocalProcessArgs,
  deps: WorkspaceCleanupHandlerDeps
): Promise<boolean | null> {
  const { worktreeId } = args
  if (typeof worktreeId !== 'string' || worktreeId.length === 0) {
    return false
  }

  let livenessUnknown = false
  if (deps.runtime) {
    try {
      if (await deps.runtime.hasTerminalsForWorktree(worktreeId)) {
        return true
      }
    } catch {
      livenessUnknown = true
    }
  }

  if (args.connectionId) {
    return hasKillableSshProcesses(args.connectionId, args.worktreePath ?? '', livenessUnknown)
  }

  const registryPtyIds = new Set(
    listRegisteredPtys()
      .filter((entry) => entry.worktreeId === worktreeId)
      .map((entry) => entry.ptyId)
  )

  const provider = deps.getLocalPtyProvider?.()
  if (!provider) {
    return registryPtyIds.size > 0 ? true : null
  }

  try {
    const prefix = `${worktreeId}@@`
    const sessions = await provider.listProcesses()
    if (
      sessions.some((session) => session.id.startsWith(prefix) || registryPtyIds.has(session.id))
    ) {
      return true
    }
    return livenessUnknown ? null : false
  } catch {
    return registryPtyIds.size > 0 ? true : null
  }
}

async function hasKillableSshProcesses(
  connectionId: string,
  worktreePath: string,
  livenessUnknown: boolean
): Promise<boolean | null> {
  const provider = getSshPtyProvider(connectionId)
  if (!provider) {
    return null
  }

  try {
    const normalizedWorktreePath = normalizeRemotePath(worktreePath)
    const sessions = await provider.listProcesses()
    if (
      sessions.some((session) => {
        if (session.id.startsWith(`${worktreePath}@@`)) {
          return true
        }
        return (
          normalizedWorktreePath.length > 0 &&
          isPathWithin(normalizeRemotePath(session.cwd), normalizedWorktreePath)
        )
      })
    ) {
      return true
    }
    return livenessUnknown ? null : false
  } catch {
    return null
  }
}

function normalizeRemotePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function isPathWithin(candidatePath: string, parentPath: string): boolean {
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`)
}

export async function scanWorkspaceCleanup(
  store: Store,
  args: WorkspaceCleanupScanArgs = {}
): Promise<WorkspaceCleanupScanResult> {
  const scannedAt = Date.now()
  const repos = store.getRepos()
  const errors: WorkspaceCleanupScanResult['errors'] = []
  const candidates: WorkspaceCleanupCandidate[] = []

  for (const repo of repos) {
    const result = await scanRepoWorkspaces({
      store,
      repo,
      scannedAt,
      targetWorktreeId: args.worktreeId,
      skipGitWorktreeIds: new Set(args.skipGitWorktreeIds ?? [])
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
  targetWorktreeId?: string
  skipGitWorktreeIds: Set<string>
}): Promise<WorkspaceCleanupScanResult> {
  const { store, repo, scannedAt, targetWorktreeId, skipGitWorktreeIds } = args
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
        // Why: cleanup should reflect only workspaces Orca can currently
        // inspect. Disconnected SSH repos are skipped in broad scans.
        return {
          scannedAt,
          candidates: targetWorktreeId
            ? synthesizeDisconnectedSshCandidates(store, repo, scannedAt, targetWorktreeId)
            : [],
          errors: []
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
    if (repo.connectionId && !targetWorktreeId) {
      // Why: broad cleanup only shows remote workspaces Orca can inspect now.
      // A connected SSH repo that fails mid-scan is omitted, not bannered.
      return { scannedAt, candidates: [], errors: [] }
    }
    errors.push(createScanError(repo, toSafeRepoScanError(error)))
    return { scannedAt, candidates: [], errors }
  }

  const worktrees = gitWorktrees
    .map((gitWorktree) => {
      const worktreeId = `${repo.id}::${gitWorktree.path}`
      const meta = store.getWorktreeMeta(worktreeId)
      return mergeWorktree(repo.id, gitWorktree, meta, repo.displayName)
    })
    .filter((worktree) => {
      if (targetWorktreeId) {
        return worktree.id === targetWorktreeId
      }
      return (
        !repoIsFolder &&
        !worktree.isMainWorktree &&
        isWorkspaceInactiveForCleanup(worktree, scannedAt)
      )
    })

  const candidates = await mapWithConcurrency(worktrees, WORKTREE_SCAN_CONCURRENCY, (worktree) =>
    buildCandidate({
      repo,
      worktree,
      scannedAt,
      provider,
      skipGit: skipGitWorktreeIds.has(worktree.id),
      forceGitCheck: Boolean(targetWorktreeId)
    }).catch((error) => {
      console.error('Workspace cleanup candidate scan failed', error)
      return buildCandidateFromError(repo, worktree, scannedAt, toErrorMessage(error))
    })
  )

  return { scannedAt, candidates, errors }
}

async function buildCandidate(args: {
  repo: Repo
  worktree: Worktree
  scannedAt: number
  provider: IGitProvider | null
  skipGit: boolean
  forceGitCheck: boolean
}): Promise<WorkspaceCleanupCandidate> {
  const { repo, worktree, scannedAt, provider, skipGit, forceGitCheck } = args
  const blockers: WorkspaceCleanupBlocker[] = []
  const reasons = getInactivityReasons(worktree, scannedAt)
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

  const localContext = buildLocalContext(worktree)
  const shouldReadGit = shouldReadGitEvidence({
    repoIsFolder,
    blockers,
    worktree,
    skipGit,
    forceGitCheck
  })

  const gitEvidence = !shouldReadGit
    ? createEmptyGitEvidence()
    : await readGitEvidence(worktree, repo, provider)
  blockers.push(...gitEvidence.blockers)

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
    localContext,
    git: {
      clean: gitEvidence.clean,
      upstreamAhead: gitEvidence.upstreamAhead,
      upstreamBehind: gitEvidence.upstreamBehind,
      checkedAt: gitEvidence.checkedAt
    },
    fingerprint: ''
  }

  const fingerprint = createWorkspaceCleanupFingerprint({
    branch: candidateWithoutFingerprint.branch,
    head: worktree.head,
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

function shouldReadGitEvidence(args: {
  repoIsFolder: boolean
  blockers: WorkspaceCleanupBlocker[]
  worktree: Worktree
  skipGit: boolean
  forceGitCheck: boolean
}): boolean {
  const { repoIsFolder, blockers, worktree, skipGit, forceGitCheck } = args
  if ((skipGit && !forceGitCheck) || repoIsFolder || worktree.isMainWorktree) {
    return false
  }
  if (
    blockers.includes('pinned') ||
    blockers.includes('main-worktree') ||
    blockers.includes('folder-repo')
  ) {
    return false
  }

  // Why: inactivity is the only recommendation signal now. Git is read only
  // to keep the destructive path from deleting dirty or local-only branch work.
  return true
}

async function readGitEvidence(
  worktree: Worktree,
  repo: Repo,
  provider: IGitProvider | null
): Promise<GitEvidence> {
  const blockers: WorkspaceCleanupBlocker[] = []
  let status: GitStatusResult
  const checkedAt = Date.now()

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
  if (clean && upstreamAhead === null) {
    const unpushedCommitCount = await readUnpushedCommitCount(worktree, repo, provider)
    if (unpushedCommitCount === null) {
      blockers.push('unknown-base')
    } else if (unpushedCommitCount > 0) {
      blockers.push('unpushed-commits')
    }
  }

  const evidence: GitEvidence = {
    clean,
    upstreamAhead,
    upstreamBehind,
    checkedAt,
    blockers
  }

  return { ...evidence, blockers: uniqueBlockers(blockers) }
}

async function readUnpushedCommitCount(
  worktree: Worktree,
  repo: Repo,
  provider: IGitProvider | null
): Promise<number | null> {
  try {
    const result = await withTimeout(
      repo.connectionId
        ? provider!.exec(['rev-list', '--count', 'HEAD', '--not', '--remotes'], worktree.path)
        : gitExecFileAsync(['rev-list', '--count', 'HEAD', '--not', '--remotes'], {
            cwd: worktree.path
          }),
      GIT_READ_TIMEOUT_MS,
      'Timed out checking unpushed commits.'
    )
    const count = Number.parseInt(result.stdout.trim(), 10)
    return Number.isFinite(count) ? count : null
  } catch {
    return null
  }
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
    reasons: getInactivityReasons(worktree, scannedAt),
    blockers: ['git-status-error'],
    lastActivityAt: worktree.lastActivityAt,
    ...(worktree.createdAt !== undefined ? { createdAt: worktree.createdAt } : {}),
    localContext: buildLocalContext(worktree),
    git: {
      clean: null,
      upstreamAhead: null,
      upstreamBehind: null,
      checkedAt: scannedAt
    },
    fingerprint: createWorkspaceCleanupFingerprint({
      branch: shortBranchName(worktree.branch),
      head: worktree.head,
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
    .filter(([worktreeId, meta]) => {
      if (!worktreeId.startsWith(`${repo.id}::`)) {
        return false
      }
      if (targetWorktreeId) {
        return targetWorktreeId === worktreeId
      }
      return isWorkspaceInactiveForCleanup(meta, scannedAt)
    })
    .map(([worktreeId, meta]) => {
      const parsed = splitWorktreeId(worktreeId)
      const path = parsed?.worktreePath ?? worktreeId
      const reasons = getInactivityReasons(meta, scannedAt)
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
        reasons,
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
          checkedAt: null
        },
        fingerprint: createWorkspaceCleanupFingerprint({
          branch: basename(path),
          head: '',
          gitClean: null,
          lastActivityAt: meta.lastActivityAt
        })
      })
    })
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

function isWorkspaceInactiveForCleanup(
  workspace: Pick<Worktree, 'isArchived' | 'lastActivityAt'>,
  scannedAt: number
): boolean {
  return isWorkspaceOldForCleanup(workspace, scannedAt)
}

function getInactivityReasons(
  workspace: Pick<Worktree, 'isArchived' | 'lastActivityAt'>,
  scannedAt: number
): WorkspaceCleanupReason[] {
  return getWorkspaceCleanupInactivityReasons(workspace, scannedAt)
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

function createScanError(repo: Repo, message: string): WorkspaceCleanupScanError {
  return {
    repoId: repo.id,
    repoName: repo.displayName || basename(repo.path),
    message
  }
}

// Why: git errors often include absolute paths or command output. Keep the
// cause useful without leaking raw local/remote filesystem details to the UI.
function toSafeRepoScanError(error: unknown): string {
  const message = toErrorMessage(error)
  if (message === 'Timed out listing SSH worktrees.') {
    return 'Timed out listing remote worktrees.'
  }
  if (message === 'Timed out listing worktrees.') {
    return 'Timed out listing worktrees.'
  }
  if (message.startsWith('Timed out ')) {
    return message.replace(/\.$/, '')
  }

  const lower = message.toLowerCase()
  if (lower.includes('not a git repository') || lower.includes('not a git worktree')) {
    return 'Repository is not a git checkout.'
  }
  if (
    lower.includes('enoent') ||
    lower.includes('no such file') ||
    lower.includes('cannot find') ||
    lower.includes('does not exist')
  ) {
    return 'Repository folder was not found.'
  }
  if (lower.includes('eacces') || lower.includes('eperm') || lower.includes('permission denied')) {
    return 'Repository folder is not accessible.'
  }
  return 'Git could not list worktrees.'
}
