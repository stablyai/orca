import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'
import { deriveGitRemoteIdentity, type GitRemoteIdentity } from '../shared/git-remote-identity'
import { gitExecFileAsync } from './git/runner'
import { resolveGitRouteForHost } from './providers/execution-host-provider-dispatch'

// Why: the runner only arms its kill timer when a timeout is passed, so an unbounded local probe
// never settles on a hung NFS/SMB cwd (the path walk blocks) or a wedged `wsl.exe -d <distro>`.
// Matches the background local-git-read budget in git/git-username.ts; a probe cut off early just
// reports `unavailable` and retries on the enrichment TTL.
const LOCAL_PROBE_TIMEOUT_MS = 5000

export type GitRemoteIdentityProbeOptions = {
  signal?: AbortSignal
  timeoutMs?: number
}

/** `no-remote` means git answered and the repo has no usable remote;
 *  `unavailable` means the probe never reached git (host down, SSH not up
 *  yet, git error) and says nothing about the repo. */
export type GitRemoteIdentityProbe =
  | { status: 'resolved'; identity: GitRemoteIdentity }
  | { status: 'no-remote' }
  | { status: 'unavailable' }

/** Runs a read-only git command in `repoPath` on the host that owns it, bounded by the probe
 *  timeouts. Resolves null when this process has no route to that host's git; throws on git errors. */
export async function runGitProbeOnHost(
  args: string[],
  repoPath: string,
  executionHostId: ExecutionHostId,
  options: GitRemoteIdentityProbeOptions = {}
): Promise<{ stdout: string } | null> {
  // A runtime server runs its own git (its repo row's SSH target is nested in that server's
  // namespace), and this process serves no `ssh:` host.
  if (resolveGitRouteForHost(executionHostId).kind !== 'local') {
    return null
  }
  return gitExecFileAsync(args, {
    cwd: repoPath,
    timeout: options.timeoutMs ?? LOCAL_PROBE_TIMEOUT_MS,
    signal: options.signal
  })
}

export async function probeGitRemoteIdentity(
  repoPath: string,
  executionHostId: ExecutionHostId,
  options: GitRemoteIdentityProbeOptions = {}
): Promise<GitRemoteIdentityProbe> {
  try {
    // Inside the try on purpose: an id naming no host must land on `unavailable` like every other
    // probe that never reached git. It must never become the local answer for a remote path.
    const result = await runGitProbeOnHost(['remote', '-v'], repoPath, executionHostId, options)
    if (!result) {
      return { status: 'unavailable' }
    }
    const identity = deriveGitRemoteIdentity(result.stdout)
    return identity ? { status: 'resolved', identity } : { status: 'no-remote' }
  } catch {
    // Repo creation must not fail because a best-effort remote probe failed. A timeout or an abort
    // lands here too, and must stay `unavailable`: only `no-remote` may clear a resolved identity.
    return { status: 'unavailable' }
  }
}

export async function detectGitRemoteIdentity(
  repoPath: string,
  executionHostId: ExecutionHostId,
  options: GitRemoteIdentityProbeOptions = {}
): Promise<GitRemoteIdentity | null> {
  const probe = await probeGitRemoteIdentity(repoPath, executionHostId, options)
  return probe.status === 'resolved' ? probe.identity : null
}

/** A registered folder's remote as git reports it now; the stored answer only when git is unreachable. */
export async function readCurrentGitRemoteIdentity(
  repo: Pick<Repo, 'path' | 'kind' | 'gitRemoteIdentity'>
): Promise<Pick<Repo, 'gitRemoteIdentity'>> {
  if (repo.kind === 'folder') {
    return { gitRemoteIdentity: null }
  }
  // Local on purpose: both setup paths register and read the folder in this process.
  const probe = await probeGitRemoteIdentity(repo.path, LOCAL_EXECUTION_HOST_ID)
  if (probe.status === 'resolved') {
    return { gitRemoteIdentity: probe.identity }
  }
  return { gitRemoteIdentity: probe.status === 'no-remote' ? null : repo.gitRemoteIdentity }
}
