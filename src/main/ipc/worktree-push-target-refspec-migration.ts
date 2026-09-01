// Why: remotes minted or reused before #17828's narrow-refspec fix are stuck on the
// wide `+refs/heads/*:refs/remotes/<name>/*` default, so any later plain `git fetch`
// keeps re-importing the fork's whole branch set. This sweep rewrites each surviving
// Orca-provenance `pr-*` remote's refspec to only the branches Orca actually tracked
// for it, then deletes the refs the earlier wide fetch already imported for every other
// branch (`git fetch --prune` cannot reclaim these once the refspec is narrow -- verified
// against real git, see #17828 PR). It never deletes a remote (that is
// `worktree-push-target-cleanup.ts`'s job) -- only narrows what a future fetch pulls.
import { gitExecFileAsync } from '../git/runner'
import {
  ensureRemoteTracksBranchNarrowly,
  getRemoteFetchRefspecs,
  pruneUntrackedForkRemoteRefs,
  wildcardForkFetchRefspec
} from '../git/fork-remote-refspec'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { iterateProcessOutputLines } from '../../shared/process-output-field-scanner'
import type { GitRemoteExec, WorktreePushTargetStore } from './worktree-push-target-cleanup'

const NEVER_MIGRATE_REMOTE_NAMES = new Set(['origin', 'upstream'])

/** `pushTarget`-derived branches to keep per remote, gated on at least one entry proving Orca created it. */
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

// `branch.<name>.remote`/`.pushRemote` config can outlive worktree metadata (preserve-on-delete),
// so a branch it protects is still worth keeping narrowly tracked even with no metadata left.
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

/**
 * Exported for tests: the `execGit` seam drives the migration matrix without a real repo.
 * Returns the names of remotes actually rewritten (wide -> narrow, then pruned).
 */
export async function migrateForkRemoteRefspecsWithExec(
  repoPath: string,
  repoId: string,
  store: WorktreePushTargetStore,
  execGit: GitRemoteExec
): Promise<string[]> {
  const branchesByRemote = collectProvenBranchesByRemote(store, repoId)
  const migrated: string[] = []
  for (const [remoteName, metaBranches] of branchesByRemote) {
    if (NEVER_MIGRATE_REMOTE_NAMES.has(remoteName)) {
      continue
    }
    const branches = new Set(metaBranches)
    for (const branch of await collectBranchesFromLocalConfig(execGit, repoPath, remoteName)) {
      branches.add(branch)
    }
    if (branches.size === 0) {
      continue
    }
    try {
      await execGit(['remote', 'get-url', remoteName], repoPath)
    } catch {
      continue // config references a remote that no longer exists
    }
    const before = await getRemoteFetchRefspecs(execGit, repoPath, remoteName)
    const wasWide = before.includes(wildcardForkFetchRefspec(remoteName))
    for (const branch of branches) {
      await ensureRemoteTracksBranchNarrowly(execGit, repoPath, remoteName, branch)
    }
    if (!wasWide) {
      continue // already narrow (minted post-fix, or a prior sweep already ran); nothing to prune
    }
    // Best-effort: the refspec is narrowed regardless of whether this local ref cleanup
    // succeeds. Purely local (no network), so failures here should be rare/unexpected.
    await pruneUntrackedForkRemoteRefs(execGit, repoPath, remoteName, branches).catch(() => [])
    migrated.push(remoteName)
  }
  return migrated
}

// Why: the sweep costs a handful of git subprocesses per candidate remote; bound to once
// per repo per cooldown so bursts of worktree creates don't repeat it.
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
