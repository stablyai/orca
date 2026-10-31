// Narrow fork fetches to known branch prefixes instead of importing every branch.
// A trailing * permits zero-match fetches after deletion; prefix-sharing sibling branches may also match.
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

/** Configuring a refspec does not fetch it; skip fetching only when its tracking ref already exists. */
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

/** config --get detects URL-less remotes; remote get-url can return the remote name as a bogus URL. */
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

/** Preserve sibling worktrees' branch refspecs, replace the broad default, and disable tag auto-follow. */
export async function ensureRemoteTracksBranchNarrowly(
  execGit: GitExecFn,
  repoPath: string,
  remoteName: string,
  branchName: string
): Promise<void> {
  const desired = buildNarrowForkFetchRefspec(remoteName, branchName)
  const existing = await getRemoteFetchRefspecs(execGit, repoPath, remoteName)
  if (!existing.includes(desired)) {
    // Drop broad defaults and exact entries that would defeat wildcard zero-match tolerance.
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
 * Reuse-path twin of `ensureRemoteTracksBranchNarrowly` for remotes Orca did not create
 * (#25703): appends the branch's narrow refspec when absent and never drops or rewrites
 * anything already configured -- the user's wide default and other branches' entries stay
 * intact, and `tagOpt` is left alone.
 */
export async function ensureRemoteAlsoTracksBranch(
  execGit: GitExecFn,
  repoPath: string,
  remoteName: string,
  branchName: string
): Promise<void> {
  const desired = buildNarrowForkFetchRefspec(remoteName, branchName)
  const existing = await getRemoteFetchRefspecs(execGit, repoPath, remoteName)
  if (!existing.includes(desired)) {
    await execGit(['config', '--add', `remote.${remoteName}.fetch`, desired], repoPath)
  }
}

/**
 * Removes every `remote.<name>.fetch` entry, leaving the remote pushable but importing
 * nothing on a plain fetch. For a fork remote with no branch pinning it at all (no
 * worktree metadata, no `branch.*.remote`/`.pushRemote` config), there's nothing to
 * narrow *to* -- but leaving the wide default in place means the next plain fetch still
 * re-imports the fork's entire branch set. See the migration sweep's caller for the
 * provenance check gating when this is safe to call.
 */
/** Clear fetch refspecs for an unpinned fork remote without disabling pushes; callers must verify provenance. */
export async function clearForkRemoteFetchRefspec(
  execGit: GitExecFn,
  repoPath: string,
  remoteName: string
): Promise<void> {
  await execGit(['config', '--unset-all', `remote.${remoteName}.fetch`], repoPath).catch(() => {})
}

/** Prune refs outside kept branch prefixes, preserving HEAD and anything the narrow refspec would fetch again. */
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
