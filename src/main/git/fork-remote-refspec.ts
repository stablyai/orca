// Why: a fork-PR remote added with a bare `git remote add` writes the default
// `+refs/heads/*:refs/remotes/<name>/*` refspec, so any later plain `git fetch <name>`
// (user, agent, or Orca's own Fetch action) imports the fork's entire branch set --
// a large fork can carry 1000+ branches. Every mint/reuse/migration path funnels
// through `ensureRemoteTracksBranchNarrowly` so a fork remote never tracks more than
// the branches Orca actually knows about (see #17828).
//
// The tracked-branch refspec source carries a trailing `*` (`refs/heads/<branch>*`)
// rather than being a literal exact match. This is deliberate: Orca is terminal-centric
// (agents run raw git in worktrees), and a *bare* `git fetch` inside a fork-PR worktree
// resolves to this remote via `branch.<name>.remote` -- it is the single most common
// fetch shape here, more common than `git fetch <explicit-remote>`. A literal refspec
// makes that fetch (and `git fetch <remote>`) hard-fail with `couldn't find remote ref`
// the moment the tracked branch is deleted/renamed upstream, where the old wide default
// silently no-op'd. A trailing `*` keeps git's wildcard zero-match tolerance (verified
// against real git: exit 0, and `--prune` correctly reclaims the ref once it can't be
// found) while still bounding the import to branches sharing that literal prefix --
// not the fork's entire branch set. The residual widening (an unrelated sibling branch
// that happens to share the prefix, e.g. `fix` also matching `fix-v2`) is accepted as
// far narrower than the bug this fixes.
export type GitExecFn = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr?: string }>

export function buildNarrowForkFetchRefspec(remoteName: string, branchName: string): string {
  return `+refs/heads/${branchName}*:refs/remotes/${remoteName}/${branchName}*`
}

export function wildcardForkFetchRefspec(remoteName: string): string {
  return `+refs/heads/*:refs/remotes/${remoteName}/*`
}

/** `[]` when the remote has no configured fetch refspec (or doesn't exist). */
export async function getRemoteFetchRefspecs(
  execGit: GitExecFn,
  repoPath: string,
  remoteName: string
): Promise<string[]> {
  try {
    const { stdout } = await execGit(
      ['config', '--get-all', `remote.${remoteName}.fetch`],
      repoPath
    )
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function refspecSource(refspec: string): string {
  return refspec.replace(/^\+/, '').split(':')[0]!
}

/**
 * True if `branchName`'s remote-tracking ref already exists locally under `remoteName`.
 * Used to skip a redundant fetch on the common repeat-materialize case (the ref was
 * already pulled in by an earlier mint/fetch) while still fetching it on demand the
 * first time a sibling worktree widens an existing remote onto a new branch -- a bare
 * refspec-config widen never itself imports anything (see `ensureRemoteTracksBranchNarrowly`).
 */
export async function forkRemoteTrackingRefExists(
  execGit: GitExecFn,
  repoPath: string,
  remoteName: string,
  branchName: string
): Promise<boolean> {
  try {
    await execGit(
      ['rev-parse', '--verify', '--quiet', `refs/remotes/${remoteName}/${branchName}`],
      repoPath
    )
    return true
  } catch {
    return false
  }
}

/**
 * True only if `remote.<name>.url` is actually set. Deliberately plumbing (`config --get`),
 * not porcelain `git remote get-url` -- the latter falls back to echoing the remote *name*
 * as a bogus "URL" when the section exists but has no url key (verified against real git),
 * which would hide exactly the config-only ghost state this guards against (see
 * `worktree-push-target-refspec-migration.ts`'s concurrent-removal race with #17842's
 * reconciliation sweep).
 */
export async function remoteHasUrl(
  execGit: GitExecFn,
  repoPath: string,
  remoteName: string
): Promise<boolean> {
  try {
    await execGit(['config', '--get', `remote.${remoteName}.url`], repoPath)
    return true
  } catch {
    return false
  }
}

/**
 * Adds `branchName` to `remoteName`'s tracked set without dropping any other branch
 * already tracked (a sibling worktree on the same fork may track a different branch --
 * see #17828 reuse-path discussion on why this widens rather than replaces). Replaces
 * the wide default wildcard refspec outright since nothing should still depend on it.
 * Also pins `tagOpt=--no-tags` so tags never auto-follow into the shared namespace.
 */
export async function ensureRemoteTracksBranchNarrowly(
  execGit: GitExecFn,
  repoPath: string,
  remoteName: string,
  branchName: string
): Promise<void> {
  const desired = buildNarrowForkFetchRefspec(remoteName, branchName)
  const existing = await getRemoteFetchRefspecs(execGit, repoPath, remoteName)
  if (!existing.includes(desired)) {
    // Strip the wide default outright, and any stray literal (non-suffixed) entry for
    // this exact branch -- e.g. a hand-edited config -- since it would shadow the same
    // source prefix and defeats the point of the trailing `*`.
    const literalForBranch = `refs/heads/${branchName}`
    const toDrop = existing.includes(wildcardForkFetchRefspec(remoteName))
      ? existing
      : existing.filter((refspec) => refspecSource(refspec) === literalForBranch)
    if (toDrop.length > 0) {
      const surviving = existing.filter((refspec) => !toDrop.includes(refspec))
      await execGit(['config', '--unset-all', `remote.${remoteName}.fetch`], repoPath)
      for (const refspec of surviving) {
        await execGit(['config', '--add', `remote.${remoteName}.fetch`, refspec], repoPath)
      }
    }
    await execGit(['config', '--add', `remote.${remoteName}.fetch`, desired], repoPath)
  }
  await execGit(['config', `remote.${remoteName}.tagOpt`, '--no-tags'], repoPath)
}

/**
 * Removes every `remote.<name>.fetch` entry, leaving the remote pushable but importing
 * nothing on a plain fetch. For a fork remote with no branch pinning it at all (no
 * worktree metadata, no `branch.*.remote`/`.pushRemote` config), there's nothing to
 * narrow *to* -- but leaving the wide default in place means the next plain fetch still
 * re-imports the fork's entire branch set. See the migration sweep's caller for the
 * provenance check gating when this is safe to call.
 */
export async function clearForkRemoteFetchRefspec(
  execGit: GitExecFn,
  repoPath: string,
  remoteName: string
): Promise<void> {
  await execGit(['config', '--unset-all', `remote.${remoteName}.fetch`], repoPath).catch(() => {})
}

/**
 * Deletes remote-tracking refs under `refs/remotes/<remoteName>/` that fall outside
 * `keepBranches`. Needed because migrating away from the old wide default leaves behind
 * refs for every branch the earlier wide fetch already pulled in, and a plain fetch under
 * the new narrow refspec never revisits (or reclaims) a branch outside its own prefix.
 * A tracking ref is kept if its branch name equals, or starts with, an entry in
 * `keepBranches` -- matching what `buildNarrowForkFetchRefspec`'s trailing `*` would also
 * match, so this never deletes a ref the configured refspec will just re-fetch anyway.
 * Returns the deleted ref names. Never touches `HEAD`.
 */
export async function pruneUntrackedForkRemoteRefs(
  execGit: GitExecFn,
  repoPath: string,
  remoteName: string,
  keepBranches: ReadonlySet<string>
): Promise<string[]> {
  const prefix = `refs/remotes/${remoteName}/`
  const { stdout } = await execGit(['for-each-ref', '--format=%(refname)', prefix], repoPath).catch(
    () => ({ stdout: '' })
  )
  const deleted: string[] = []
  for (const refname of stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    const branch = refname.slice(prefix.length)
    const kept = branch === 'HEAD' || [...keepBranches].some((keep) => branch.startsWith(keep))
    if (kept) {
      continue
    }
    await execGit(['update-ref', '-d', refname], repoPath)
    deleted.push(refname)
  }
  return deleted
}

/** Drops the one refspec whose source is `refs/heads/<staleBranchName>`, keeping the rest. */
export async function removeStaleForkFetchRefspec(
  execGit: GitExecFn,
  repoPath: string,
  remoteName: string,
  staleBranchName: string
): Promise<boolean> {
  const existing = await getRemoteFetchRefspecs(execGit, repoPath, remoteName)
  const staleSource = `refs/heads/${staleBranchName}`
  const surviving = existing.filter((refspec) => refspecSource(refspec) !== staleSource)
  if (surviving.length === existing.length) {
    return false
  }
  await execGit(['config', '--unset-all', `remote.${remoteName}.fetch`], repoPath)
  for (const refspec of surviving) {
    await execGit(['config', '--add', `remote.${remoteName}.fetch`, refspec], repoPath)
  }
  return true
}
