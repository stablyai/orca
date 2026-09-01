// Why: a fork-PR remote added with a bare `git remote add` writes the default
// `+refs/heads/*:refs/remotes/<name>/*` refspec, so any later plain `git fetch <name>`
// (user, agent, or Orca's own Fetch action) imports the fork's entire branch set --
// a large fork can carry 1000+ branches. Every mint/reuse/migration path funnels
// through `ensureRemoteTracksBranchNarrowly` so a fork remote never tracks more than
// the branches Orca actually knows about (see #17828).
export type GitExecFn = (
  args: string[],
  cwd: string
) => Promise<{ stdout: string; stderr?: string }>

export function buildNarrowForkFetchRefspec(remoteName: string, branchName: string): string {
  return `+refs/heads/${branchName}:refs/remotes/${remoteName}/${branchName}`
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
    if (existing.includes(wildcardForkFetchRefspec(remoteName))) {
      await execGit(['config', '--unset-all', `remote.${remoteName}.fetch`], repoPath)
    }
    await execGit(['config', '--add', `remote.${remoteName}.fetch`, desired], repoPath)
  }
  await execGit(['config', `remote.${remoteName}.tagOpt`, '--no-tags'], repoPath)
}

/**
 * Deletes remote-tracking refs under `refs/remotes/<remoteName>/` that fall outside
 * `keepBranches`. Needed because `git fetch --prune` only reclaims refs a *wildcard*
 * refspec could reproduce -- once a remote is narrowed to literal branch refspecs, git
 * has no way to know a `refs/remotes/<name>/<other-branch>` ref "belongs" to it, so
 * `--prune` silently leaves every stray from the old wide fetch in place (verified against
 * real git; see #17828). Returns the deleted ref names. Never touches `HEAD`.
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
    if (branch === 'HEAD' || keepBranches.has(branch)) {
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
