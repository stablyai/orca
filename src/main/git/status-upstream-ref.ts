import { isSafeGitRefName } from '../../shared/git-status-upstream-ref'

type GitStatusUpstreamRefExec = (
  args: string[],
  cwd: string,
  signal: AbortSignal
) => Promise<{ stdout: string }>

function exactRefFromOutput(stdout: string): string | undefined {
  const refs = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(isSafeGitRefName)
  return refs.length === 1 ? refs[0] : undefined
}

export async function resolveGitStatusUpstreamRef(
  execGit: GitStatusUpstreamRefExec,
  worktreePath: string,
  branch: string,
  upstreamName: string,
  signal: AbortSignal
): Promise<string | undefined> {
  if (!branch.startsWith('refs/heads/') || !isSafeGitRefName(branch)) {
    return undefined
  }
  const result = await execGit(
    ['for-each-ref', '--format=%(refname)%00%(upstream)%00%(upstream:short)', '--count=1', branch],
    worktreePath,
    signal
  )
  const fields = result.stdout.replace(/\r?\n$/, '').split('\0')
  if (fields.length !== 3 || fields[0] !== branch) {
    return undefined
  }
  if (fields[2] === upstreamName) {
    return exactRefFromOutput(fields[1])
  }
  try {
    const effective = await execGit(
      ['rev-parse', '--symbolic-full-name', '--end-of-options', upstreamName],
      worktreePath,
      signal
    )
    return exactRefFromOutput(effective.stdout)
  } catch {
    if (signal.aborted) {
      throw signal.reason
    }
    return undefined
  }
}
