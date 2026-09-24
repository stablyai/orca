import { isPathInsideOrEqual } from '../shared/cross-platform-path'
import { isProvenLivePtyRemovalError } from '../shared/worktree/removal'
import {
  formatLiveWorktreePidBlocker,
  qualifiesForFinishedWorktreeForceCleanup
} from '../shared/worktree/finished-worktree-force-cleanup'
import type { LocalProjectWorktreeGitOptions } from './project-runtime-git-options'
import { gitExecFileAsync } from './git/runner'
import { getRepoDefaultBranchName } from './source-control/repo-default-branch'
import {
  getLocalWorktreePathAccess,
  removeLocalWorktreePath,
  toLocalWorktreeRuntimePath
} from './local-worktree-filesystem'
import { canSafelyRemoveOrphanedWorktreeDirectory } from './worktree-removal-safety'
import { CLIENT_REMOVAL_HOME } from './worktree-removal-home-guard'
import { getLocalPtyProvider } from './ipc/pty'
import { listRegisteredPtys } from './memory/pty-registry'
import {
  forceKillFinishedWorktreeSessionTree,
  type FinishedSessionTreeKillResult
} from './worktree-finished-session-tree-kill'

export const WORKTREE_DIRECTORY_KEPT_METADATA_MESSAGE =
  'Failed to delete the worktree directory. The workspace record was kept so you can retry deletion.'

export type WorktreeSessionPidSource = {
  id: string
  worktreeId?: string
  cwd?: string
  rootProcessId?: number
  paneBound?: boolean
}

export type FinishedWorktreeForceCleanupPlan = {
  qualifies: boolean
  rootPids: number[]
  livePids: number[]
}

export const EMPTY_FINISHED_WORKTREE_FORCE_CLEANUP_PLAN: FinishedWorktreeForceCleanupPlan = {
  qualifies: false,
  rootPids: [],
  livePids: []
}

type RegistrationPid = {
  worktreeId: string | null
  pid: number | null
}

export function collectWorktreeSessionTree(args: {
  worktreeId: string
  worktreePath: string
  registrations: readonly RegistrationPid[]
  sessions: readonly WorktreeSessionPidSource[]
}): { rootPids: number[]; hasLiveUiVisibleSession: boolean } {
  const prefix = `${args.worktreeId}@@`
  const pids = new Set<number>()
  let hasLiveUiVisibleSession = false
  const ownsSession = (session: WorktreeSessionPidSource): boolean => {
    if (session.id.startsWith(prefix) || session.worktreeId === args.worktreeId) {
      return true
    }
    return (
      typeof session.cwd === 'string' &&
      session.cwd.length > 0 &&
      args.worktreePath.length > 0 &&
      isPathInsideOrEqual(args.worktreePath, session.cwd)
    )
  }
  for (const session of args.sessions) {
    if (!ownsSession(session)) {
      continue
    }
    if (session.paneBound === true) {
      hasLiveUiVisibleSession = true
    }
    if (session.rootProcessId !== undefined && isUsablePid(session.rootProcessId)) {
      pids.add(session.rootProcessId)
    }
  }
  for (const entry of args.registrations) {
    if (entry.worktreeId === args.worktreeId && entry.pid !== null && isUsablePid(entry.pid)) {
      pids.add(entry.pid)
    }
  }
  return { rootPids: [...pids], hasLiveUiVisibleSession }
}

function isUsablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1 && pid !== process.pid
}

export async function countCommitsAheadOfDefaultBranch(
  repoPath: string,
  branch: string,
  options: LocalProjectWorktreeGitOptions = {}
): Promise<number | null> {
  const short = branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch
  if (!short || short === 'HEAD' || short.includes('..')) {
    return null
  }
  const defaultName = await getRepoDefaultBranchName(repoPath, null, options)
  if (!defaultName) {
    return null
  }
  if (defaultName === short) {
    return 0
  }
  try {
    // rev-list --count and --end-of-options both predate the Git 2.25 baseline.
    const { stdout } = await gitExecFileAsync(
      ['rev-list', '--count', '--end-of-options', `${defaultName}..${short}`],
      {
        cwd: repoPath,
        timeout: 15_000,
        ...(options.wslDistro ? { wslDistro: options.wslDistro } : {})
      }
    )
    const count = Number.parseInt(stdout.trim(), 10)
    return Number.isInteger(count) && count >= 0 ? count : null
  } catch {
    return null
  }
}

export async function runLocalFinishedWorktreeForceCleanup(args: {
  allowUnverifiedPtyStop: boolean
  worktreeId: string
  worktreePath: string
  branch: string
  repoPath: string
  hasAutomationProvenance: boolean
  workspaceStatus?: string | null
  localOptions?: LocalProjectWorktreeGitOptions
  listSessions?: () => Promise<readonly WorktreeSessionPidSource[]>
  listRegistrations?: () => readonly RegistrationPid[]
  countAhead?: (repoPath: string, branch: string) => Promise<number | null>
  killTree?: (pids: readonly number[]) => Promise<FinishedSessionTreeKillResult>
}): Promise<FinishedWorktreeForceCleanupPlan> {
  const sessions = await (args.listSessions ?? listLocalWorktreeSessions)()
  const registrations = (args.listRegistrations ?? listRegisteredPtys)()
  const tree = collectWorktreeSessionTree({
    worktreeId: args.worktreeId,
    worktreePath: args.worktreePath,
    registrations,
    sessions
  })
  const needsAhead =
    !args.hasAutomationProvenance &&
    args.workspaceStatus !== 'completed' &&
    !tree.hasLiveUiVisibleSession
  const commitsAheadOfDefault = needsAhead
    ? await (
        args.countAhead ??
        ((repoPath: string, branch: string) =>
          countCommitsAheadOfDefaultBranch(repoPath, branch, args.localOptions))
      )(args.repoPath, args.branch)
    : null
  const qualifies = qualifiesForFinishedWorktreeForceCleanup({
    hasAutomationProvenance: args.hasAutomationProvenance,
    workspaceStatus: args.workspaceStatus,
    commitsAheadOfDefault,
    hasLiveUiVisibleSession: tree.hasLiveUiVisibleSession
  })
  if (!args.allowUnverifiedPtyStop || !qualifies || tree.rootPids.length === 0) {
    return { qualifies, rootPids: tree.rootPids, livePids: [] }
  }
  const killed = await (args.killTree ?? forceKillFinishedWorktreeSessionTree)(tree.rootPids)
  return { qualifies, rootPids: tree.rootPids, livePids: killed.livePids }
}

export function rewriteUnstoppedPtyErrorForFinishedWorktree(
  error: unknown,
  plan: FinishedWorktreeForceCleanupPlan
): Error {
  const original = error instanceof Error ? error : new Error(String(error))
  if (
    !plan.qualifies ||
    plan.rootPids.length === 0 ||
    !isProvenLivePtyRemovalError(original.message)
  ) {
    return original
  }
  return new Error(formatLiveWorktreePidBlocker(plan.rootPids), { cause: original })
}

export async function settleOrphanedLocalWorktreeDirectory(args: {
  worktreePath: string
  repoPath: string
  options: LocalProjectWorktreeGitOptions
  closeWatchers: (path: string) => Promise<void>
}): Promise<'gone' | 'still-present'> {
  const access = getLocalWorktreePathAccess(args.options)
  const runtimeWorktreePath = toLocalWorktreeRuntimePath(args.worktreePath, args.options)
  const runtimeRepoPath = toLocalWorktreeRuntimePath(args.repoPath, args.options)
  if (
    await canSafelyRemoveOrphanedWorktreeDirectory(
      runtimeWorktreePath,
      runtimeRepoPath,
      CLIENT_REMOVAL_HOME,
      access.statPath,
      access.readPath
    )
  ) {
    await args.closeWatchers(args.worktreePath)
    try {
      await removeLocalWorktreePath(args.worktreePath, args.options)
    } catch (error) {
      console.warn(
        `[worktrees] Directory removal failed for ${args.worktreePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  } else {
    console.warn(
      `[worktrees] Refusing recursive cleanup for unproven worktree directory: ${args.worktreePath}`
    )
  }
  return directoryStillPresent(access.statPath, runtimeWorktreePath)
}

async function directoryStillPresent(
  statPath: (path: string) => Promise<unknown>,
  path: string
): Promise<'gone' | 'still-present'> {
  try {
    await statPath(path)
    return 'still-present'
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined
    // Only a proven absence may drop the workspace record. A stat we could not
    // read is not evidence the directory is gone.
    return code === 'ENOENT' ? 'gone' : 'still-present'
  }
}

export function errorIfOrphanDirectoryRemains(
  settlement: 'gone' | 'still-present',
  worktreePath: string,
  plan: FinishedWorktreeForceCleanupPlan
): Error | null {
  if (settlement === 'gone') {
    return null
  }
  const pids = plan.livePids.length > 0 ? plan.livePids : plan.qualifies ? plan.rootPids : []
  if (pids.length > 0) {
    return new Error(formatLiveWorktreePidBlocker(pids))
  }
  return new Error(`${WORKTREE_DIRECTORY_KEPT_METADATA_MESSAGE} ${worktreePath}`)
}

async function listLocalWorktreeSessions(): Promise<WorktreeSessionPidSource[]> {
  const provider = getLocalPtyProvider()
  if (!provider || typeof provider.listProcesses !== 'function') {
    return []
  }
  try {
    return await provider.listProcesses()
  } catch {
    return []
  }
}
