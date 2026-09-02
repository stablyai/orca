// Why: remotes minted or reused before #17828's narrow-refspec fix are stuck on the
// wide `+refs/heads/*:refs/remotes/<name>/*` default, so any later plain `git fetch`
// keeps re-importing the fork's whole branch set. This sweep rewrites each surviving
// Orca-provenance `pr-*` remote's refspec to only the branches Orca actually tracked
// for it, then deletes the refs the earlier wide fetch already imported for every other
// branch (`git fetch --prune` cannot reclaim these once the refspec is narrow -- verified
// against real git, see #17828 PR). It never deletes a remote (that is
// `worktree-push-target-cleanup.ts`'s job) -- only narrows what a future fetch pulls.
//
// Candidate discovery also widens past worktree metadata to every `pr-*` remote on disk
// (see `listRemoteNames` below): metadata-only discovery misses a remote whose every
// worktree was removed outside preserve-on-delete (worktree gone *and* metadata purged,
// not just the worktree) -- field data on a real repo found 15 of 31 fork remotes with no
// branch pinning them at all, permanently invisible to metadata-only discovery and stuck
// wide forever. For those, there's nothing to narrow *to*, so the sweep clears the fetch
// refspec entirely instead (stays pushable, imports nothing on a plain fetch) -- gated on
// the remote still carrying the untouched stock wide default, since a `pr`-prefixed name
// alone isn't proof of Orca provenance the way a metadata entry is.
//
// Interaction with `worktree-push-target-reconciliation.ts` (#17842, orphaned `pr-*`
// remote reclamation): the two sweeps fire from different lifecycle events (this one
// from worktree creation, that one from worktree removal), rate-limit via separate
// `Map<repoId, timestamp>` cooldowns, and so never share state or starve each other.
// They *can* still race on the same remote if creation and removal happen close
// together for the same repo, because both derive their candidate remotes from the
// same worktree-metadata store: a remote reconciliation is about to reclaim (no live
// worktree still claims it) can be one this sweep is concurrently narrowing (its stale
// metadata entry hasn't been pruned from the store yet). `remoteHasUrl` re-checked both
// before and after the narrowing writes closes the practical impact of that race down
// to "reconciliation wins and this sweep's writes get cleaned back up" rather than a
// stray url-less `remote.<name>.*` config section -- see the guard below.

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
// Fork remotes are always minted as `pr-${slug}` (see pull-request-push-target.ts). Used
// only as a secondary discovery signal below for remotes with zero metadata trace --
// primary gating stays the wide-refspec check, not this prefix alone.
const PR_REMOTE_NAME_PREFIX = 'pr-'

async function listRemoteNames(execGit: GitRemoteExec, repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execGit(['remote'], repoPath)
    return [...iterateProcessOutputLines(stdout)].map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

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
  // Why: `branchesByRemote` only surfaces remotes with a *surviving* worktree-metadata
  // entry. A remote whose every worktree was removed outside preserve-on-delete (metadata
  // purged, not just the worktree) is invisible to it -- field data on a real repo found
  // 15 of 31 fork remotes with zero branch pinning at all, still stuck wide. Widen
  // discovery to every `pr-*` remote on disk so those aren't silently skipped forever.
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
      continue // config references a remote that no longer exists
    }
    const before = await getRemoteFetchRefspecs(execGit, repoPath, remoteName)
    const wasWide = before.includes(wildcardForkFetchRefspec(remoteName))
    if (branches.size === 0) {
      // No metadata and no branch config pins this remote to anything -- there's nothing
      // to narrow *to*. Only act if it's still the untouched stock wide default: that's
      // the strongest available signal this came from a bare `git remote add` (ours or a
      // pre-#17828 Orca's), not a `pr`-prefixed remote a user configured by hand. Clears
      // rather than deletes -- removing the remote outright stays #17842's job.
      if (!wasWide) {
        continue
      }
      await clearForkRemoteFetchRefspec(execGit, repoPath, remoteName)
    } else {
      for (const branch of branches) {
        await ensureRemoteTracksBranchNarrowly(execGit, repoPath, remoteName, branch)
      }
    }
    // #17842's reconciliation sweep can concurrently `remote remove` this same
    // remote (both sweeps derive their candidate list from the same, possibly-stale,
    // worktree metadata). `remote remove` deletes the whole `remote.<name>.*` section,
    // but `ensureRemoteTracksBranchNarrowly` above would have just resurrected a
    // url-less `fetch`/`tagOpt` section via plain `config --add`, which doesn't care
    // whether the remote "exists". Detect that and clean up instead of leaving ghost
    // config behind -- narrows but does not close the race (no cross-process lock
    // exists), so this is a best-effort self-heal, not a guarantee.
    if (!(await remoteHasUrl(execGit, repoPath, remoteName))) {
      await execGit(['config', '--remove-section', `remote.${remoteName}`], repoPath).catch(
        () => {}
      )
      continue
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
