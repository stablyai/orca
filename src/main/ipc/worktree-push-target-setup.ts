// Why: preparing a fork-PR push target means adding (or reusing) the contributor's
// fork as a git remote, fetching the head, and wiring the new branch's upstream.
// The git-driven core lives here behind an injectable `execGit` seam so the
// remote-reuse / unique-naming / fetch behavior is unit-testable without a real
// repo. The store-aware ownership decision stays with the caller via a predicate.

import type { GitPushTarget } from '../../shared/worktree/types'
import { findGitRemoteNameByFetchUrl } from '../../shared/git-remote-url-index'
import { sameGitHubRemoteUrl, type GitRemoteExec } from './worktree-push-target-cleanup'
import {
  buildNarrowForkFetchRefspec,
  ensureRemoteTracksBranchNarrowly
} from '../git/fork-remote-refspec'

// One `git remote -v` replaces `git remote` plus a serial `git remote get-url` per
// remote -- 59 subprocesses at 58 remotes, on every push-target resolution (#17914).
export async function findRemoteForUrl(
  execGit: GitRemoteExec,
  repoPath: string,
  remoteUrl: string
): Promise<string | null> {
  try {
    const { stdout } = await execGit(['remote', '-v'], repoPath)
    return findGitRemoteNameByFetchUrl(stdout, (candidateUrl) =>
      sameGitHubRemoteUrl(candidateUrl, remoteUrl)
    )
  } catch {
    return null
  }
}

// O(1) probe used before materializing on demand (push/pull/fetch/fast-forward):
// a single `remote get-url <name>` skips the whole-remote-table read once a fork
// remote already exists under its expected name (#17828).
export async function remoteAlreadyMatchesUrl(
  execGit: GitRemoteExec,
  repoPath: string,
  remoteName: string,
  remoteUrl: string
): Promise<boolean> {
  try {
    const { stdout } = await execGit(['remote', 'get-url', remoteName], repoPath)
    return sameGitHubRemoteUrl(stdout.trim(), remoteUrl)
  } catch {
    return false
  }
}

// Why (#17828 CodeRabbit follow-up): a deferred remote materialized after create
// (terminal spawn, push/pull/fetch) must restore the upstream link create used to
// configure, or raw `git pull`/`git log @{u}..` keep failing even once the remote
// exists. The checked-out branch is resolved fresh rather than threaded through
// every materialize call site, since `target.branchName` is the fork's PR head ref
// and can differ from the worktree's local branch name (rename-on-collision).
export async function resolveCheckedOutBranchName(
  execGit: GitRemoteExec,
  repoPath: string
): Promise<string | null> {
  try {
    const { stdout } = await execGit(['symbolic-ref', '--short', 'HEAD'], repoPath)
    const branch = stdout.trim()
    return branch.length > 0 ? branch : null
  } catch {
    // Detached HEAD or an unreadable ref -- nothing to point upstream.
    return null
  }
}

export async function ensureUniqueRemoteName(
  execGit: GitRemoteExec,
  repoPath: string,
  preferred: string
): Promise<string> {
  const { stdout } = await execGit(['remote'], repoPath)
  const existing = new Set(
    stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  )
  if (!existing.has(preferred)) {
    return preferred
  }
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${preferred}-${suffix}`
    if (!existing.has(candidate)) {
      return candidate
    }
  }
  throw new Error(`Could not find an available remote name for ${preferred}.`)
}

// Exported for unit tests: the `execGit` seam drives the remote add/reuse/fetch
// behavior without a real repo. `isRemoteCreatedByKnownWorktree` lets the caller
// inject the store-aware ownership decision for the reuse case.
export async function prepareWorktreePushTargetWithExec(
  execGit: GitRemoteExec,
  repoPath: string,
  target: GitPushTarget,
  isRemoteCreatedByKnownWorktree: (existingRemote: string) => boolean
): Promise<GitPushTarget> {
  const { remoteCreated: _ignoredRemoteCreated, ...sanitizedTarget } = target
  let remoteName = target.remoteName
  let remoteCreated = false
  // Why: ownership above is inherited from sibling worktrees, so it can be true
  // for a remote this call did not create. Only rollback needs that distinction.
  let remoteAddedHere = false
  if (target.remoteUrl) {
    const existingRemote = await findRemoteForUrl(execGit, repoPath, target.remoteUrl)
    if (existingRemote) {
      remoteName = existingRemote
      // Why: if a later PR worktree reuses an Orca-created fork remote, it
      // must inherit ownership so deleting the final user can remove it.
      remoteCreated = isRemoteCreatedByKnownWorktree(existingRemote)
      // Why: a remote created before this fix (or reused for a second branch on the
      // same fork) may still carry the wide default refspec; widen-but-bound it to
      // cover this branch too rather than trusting whatever is already configured.
      await ensureRemoteTracksBranchNarrowly(execGit, repoPath, remoteName, target.branchName)
    } else {
      remoteName = await ensureUniqueRemoteName(execGit, repoPath, target.remoteName)
      // Why: `-t <branch> --no-tags` means this remote is never, even transiently,
      // written with the wide default `refs/heads/*` refspec + tag auto-follow (#17828).
      await execGit(
        ['remote', 'add', '-t', target.branchName, '--no-tags', remoteName, target.remoteUrl],
        repoPath
      )
      remoteAddedHere = true
      try {
        // `-t` itself writes a literal (non-wildcard-suffixed) refspec, so immediately
        // rewrite it to the trailing-`*` form via `ensureRemoteTracksBranchNarrowly`
        // (see that function's comment for why the suffix matters).
        await ensureRemoteTracksBranchNarrowly(execGit, repoPath, remoteName, target.branchName)
        // Why: repo-local provenance that survives a store purge and is removed
        // atomically with the remote itself, unlike the store's `remoteCreated` flag.
        await execGit(['config', `remote.${remoteName}.orca-created`, 'true'], repoPath)
      } catch (error) {
        // Why: a half-configured remote with no provenance marker is unreclaimable --
        // cleanup only runs off that marker, so a failure here must undo the add.
        await execGit(['remote', 'remove', remoteName], repoPath).catch(() => {})
        throw error
      }
      remoteCreated = true
    }
  }

  try {
    await execGit(
      ['fetch', remoteName, buildNarrowForkFetchRefspec(remoteName, target.branchName)],
      repoPath
    )
  } catch (error) {
    // Why: the create this remote was added for is failing; leaving it behind
    // orphans a pr-* remote nothing will ever clean up (cleanup runs on worktree
    // removal, and no worktree exists). A reused remote is still in use by the
    // sibling worktree that owns it, so removing it would break that worktree.
    if (remoteAddedHere) {
      await execGit(['remote', 'remove', remoteName], repoPath).catch(() => {})
    }
    throw error
  }
  return {
    ...sanitizedTarget,
    remoteName,
    ...(remoteCreated ? { remoteCreated: true } : {})
  }
}

// Why (#17828 CodeRabbit follow-up, restructured per review): materializing the remote
// alone isn't enough -- raw `git pull`/`git push`/`git log @{u}..` still fail without the
// upstream link create-time configuration used to set up. This must run at the *materializer*
// level (called by both the short-circuit and full-prepare paths in worktree-remote.ts), not
// buried inside `prepare*`, or every call after the first materialize -- and any sibling
// worktree that reuses the same fork remote -- never reaches it. Unconditional (not just
// "newly added") because a reused remote's upstream for *this* worktree's branch isn't
// guaranteed set. The checked-out branch is resolved fresh rather than threaded through
// every materialize call site, since `target.branchName` is the fork's PR head ref and can
// differ from the worktree's local branch name (rename-on-collision).
export async function restoreUpstreamAfterMaterialize(
  execGit: GitRemoteExec,
  worktreePath: string,
  target: GitPushTarget
): Promise<GitPushTarget> {
  if (!target.remoteUrl) {
    return target
  }
  const checkedOutBranch = await resolveCheckedOutBranchName(execGit, worktreePath)
  if (!checkedOutBranch) {
    return target
  }
  return configureCreatedWorktreePushTargetWithExec(execGit, worktreePath, checkedOutBranch, target)
}

export async function configureCreatedWorktreePushTargetWithExec(
  execGit: GitRemoteExec,
  worktreePath: string,
  branchName: string,
  target: GitPushTarget
): Promise<GitPushTarget> {
  await execGit(
    ['branch', '--set-upstream-to', `${target.remoteName}/${target.branchName}`, branchName],
    worktreePath
  )
  return target
}
