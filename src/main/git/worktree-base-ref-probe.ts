import { gitExecFileAsync } from './runner'

type GitExecOptions = {
  wslDistro?: string
}

/**
 * Returns the probed commit oid, or null when the ref does not resolve.
 *
 * Why expose the oid: the probe already prints it, and callers that then need the
 * same ref's oid were re-spawning `rev-parse` for a value this call threw away.
 */
export async function resolveWorktreeBaseCommitOid(
  repoPath: string,
  qualifiedRef: string,
  options: GitExecOptions = {}
): Promise<string | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--verify', '--quiet', `${qualifiedRef}^{commit}`],
      {
        cwd: repoPath,
        ...options
      }
    )
    const oid = stdout.trim()
    return oid.length > 0 ? oid : null
  } catch {
    return null
  }
}

export async function hasWorktreeBaseCommitRef(
  repoPath: string,
  qualifiedRef: string,
  options: GitExecOptions = {}
): Promise<boolean> {
  return (await resolveWorktreeBaseCommitOid(repoPath, qualifiedRef, options)) !== null
}

export type WorktreeBaseRefPresence = 'present' | 'absent' | 'unknown'

/**
 * Distinguish "the ref does not exist" from "the probe itself failed".
 *
 * Why for-each-ref: it exits 0 whether or not the pattern matches, so an empty result
 * proves absence while a rejection still means the probe never ran (broken repo, dead
 * SSH transport). `rev-parse --verify --quiet` exits 1 for both, and reading that as
 * "absent" would silently drop warnings the caller must still surface.
 *
 * Executor-injected so the SSH path can route the same argv through the relay.
 */
export async function probeWorktreeBaseRefPresence(
  runGit: (args: string[]) => Promise<{ stdout: string }>,
  qualifiedRef: string
): Promise<WorktreeBaseRefPresence> {
  try {
    const { stdout } = await runGit([
      'for-each-ref',
      '--count=1',
      '--format=%(refname)',
      qualifiedRef
    ])
    return stdout.trim() === qualifiedRef ? 'present' : 'absent'
  } catch {
    return 'unknown'
  }
}
