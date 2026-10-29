// Narrow legacy fork fetches and prune previously imported branches; include metadata-free pr-* remotes only with stock-wide refspecs.
// Reconciliation can remove candidates concurrently; URL rechecks best-effort repair resurrected config without a cross-process lock.

import { gitExecFileAsync } from '../git/runner'
import {
  clearForkRemoteFetchRefspec,
  ensureRemoteTracksBranchNarrowly,
  getRemoteFetchRefspecs,
  pruneUntrackedForkRemoteRefs,
  remoteHasUrl,
  wildcardForkFetchRefspec
} from '../git/fork-remote-refspec'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { iterateProcessOutputLines } from '../../shared/process-output-field-scanner'
import type { GitRemoteExec, WorktreePushTargetStore } from './worktree-push-target-cleanup'

const NEVER_MIGRATE_REMOTE_NAMES = new Set(['origin', 'upstream'])
// Prefix narrows metadata-free candidates; untouched wide refspec is the stronger migration gate.
const PR_REMOTE_NAME_PREFIX = 'pr-'

async function listRemoteNames(execGit: GitRemoteExec, repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execGit(['remote'], repoPath)
    return [...iterateProcessOutputLines(stdout)].map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

function collectProvenBranchesByRemote(
  store: WorktreePushTargetStore,
  repoId: string
): Map<string, Set<string>> {
  const branchesByRemote = new Map<string, Set<string>>()
  const provenRemotes = new Set<string>()
  for (const [worktreeId, meta] of Object.entries(store.getAllWorktreeMeta())) {
    if (getRepoIdFromWorktreeId(worktreeId) !== repoId || !meta.pushTarget) {
      continue
    }
    const { remoteName, branchName, remoteCreated } = meta.pushTarget
    if (remoteCreated === true) {
      provenRemotes.add(remoteName)
    }
    const branches = branchesByRemote.get(remoteName) ?? new Set<string>()
    branches.add(branchName)
    branchesByRemote.set(remoteName, branches)
  }
  for (const remoteName of branchesByRemote.keys()) {
    if (!provenRemotes.has(remoteName)) {
      branchesByRemote.delete(remoteName)
    }
  }
  return branchesByRemote
}

// Preserved branch config can outlive metadata; retain those existing branches in narrow tracking.
async function collectBranchesFromLocalConfig(
  execGit: GitRemoteExec,
  repoPath: string,
  remoteName: string
): Promise<string[]> {
  let stdout: string
  try {
    ;({ stdout } = await execGit(
      ['config', '--get-regexp', '^branch\\..*\\.(remote|pushRemote)$'],
      repoPath
    ))
  } catch {
    return []
  }
  const branches: string[] = []
  for (const line of iterateProcessOutputLines(stdout)) {
    const match = /^branch\.(.+)\.(?:remote|pushRemote) (.+)$/.exec(line.trim())
    if (match && match[2] === remoteName) {
      branches.push(match[1]!)
    }
  }
  return branches
}

/** Return rewritten remotes after narrowing and best-effort local ref pruning. */
export async function migrateForkRemoteRefspecsWithExec(
  repoPath: string,
  repoId: string,
  store: WorktreePushTargetStore,
  execGit: GitRemoteExec
): Promise<string[]> {
  const branchesByRemote = collectProvenBranchesByRemote(store, repoId)
  // External removal can purge every metadata trace; also discover on-disk pr-* remotes.
  const candidateNames = new Set(branchesByRemote.keys())
  for (const remoteName of await listRemoteNames(execGit, repoPath)) {
    if (remoteName.startsWith(PR_REMOTE_NAME_PREFIX)) {
      candidateNames.add(remoteName)
    }
  }
  const migrated: string[] = []
  for (const remoteName of candidateNames) {
    if (NEVER_MIGRATE_REMOTE_NAMES.has(remoteName)) {
      continue
    }
    const branches = new Set(branchesByRemote.get(remoteName) ?? [])
    for (const branch of await collectBranchesFromLocalConfig(execGit, repoPath, remoteName)) {
      branches.add(branch)
    }
    if (!(await remoteHasUrl(execGit, repoPath, remoteName))) {
      continue
    }
    const before = await getRemoteFetchRefspecs(execGit, repoPath, remoteName)
    const wasWide = before.includes(wildcardForkFetchRefspec(remoteName))
    if (branches.size === 0) {
      // Unpinned stock-wide remotes can stop fetching without removal; preserve custom refspecs on user-configured remotes.
      if (!wasWide) {
        continue
      }
      await clearForkRemoteFetchRefspec(execGit, repoPath, remoteName)
    } else {
      for (const branch of branches) {
        await ensureRemoteTracksBranchNarrowly(execGit, repoPath, remoteName, branch)
      }
    }
    // Concurrent removal may leave config-only ghosts; recheck URL and repair best-effort without claiming a lock.
    if (!(await remoteHasUrl(execGit, repoPath, remoteName))) {
      await execGit(['config', '--remove-section', `remote.${remoteName}`], repoPath).catch(
        () => {}
      )
      continue
    }
    if (!wasWide) {
      continue
    }
    // Ref pruning is local and best-effort; fetch narrowing survives cleanup failure.
    await pruneUntrackedForkRemoteRefs(execGit, repoPath, remoteName, branches).catch(() => [])
    migrated.push(remoteName)
  }
  return migrated
}

// Rate-limit subprocess-heavy migration per repo across bursts of worktree creation.
const MIGRATE_COOLDOWN_MS = 60 * 60 * 1000
const lastMigratedAtByRepoId = new Map<string, number>()

function shouldMigrateNow(repoId: string): boolean {
  const last = lastMigratedAtByRepoId.get(repoId)
  return last === undefined || Date.now() - last >= MIGRATE_COOLDOWN_MS
}

export function _resetForkRemoteRefspecMigrationRateLimitForTests(): void {
  lastMigratedAtByRepoId.clear()
}

/** Best-effort, rate-limited sweep; call sites fire this without awaiting it. */
export async function migrateForkRemoteRefspecs(
  repoPath: string,
  repoId: string,
  store: WorktreePushTargetStore,
  gitOptions: { wslDistro?: string } = {}
): Promise<void> {
  if (!shouldMigrateNow(repoId)) {
    return
  }
  lastMigratedAtByRepoId.set(repoId, Date.now())
  try {
    const migrated = await migrateForkRemoteRefspecsWithExec(repoPath, repoId, store, (args, cwd) =>
      gitExecFileAsync(args, { cwd, ...gitOptions })
    )
    if (migrated.length > 0) {
      console.log(
        `[worktrees] Narrowed fetch refspec for ${migrated.length} fork remote(s) in ${repoPath}: ${migrated.join(', ')}`
      )
    }
  } catch (error) {
    console.warn(`[worktrees] Fork remote refspec migration failed for ${repoPath}:`, error)
  }
}
