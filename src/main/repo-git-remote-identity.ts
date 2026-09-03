import type { ExecutionHostId } from '../shared/execution-host'
import { deriveGitRemoteIdentity, type GitRemoteIdentity } from '../shared/git-remote-identity'
import { gitExecFileAsync } from './git/runner'
import { resolveGitRouteForHost } from './providers/execution-host-provider-dispatch'

// Why: the runner only arms its kill timer when a timeout is passed, so an unbounded local probe
// never settles on a hung NFS/SMB cwd (the path walk blocks) or a wedged `wsl.exe -d <distro>`.
// Matches the background local-git-read budget in git/git-username.ts; a probe cut off early just
// reports `unavailable` and retries on the enrichment TTL.
const LOCAL_PROBE_TIMEOUT_MS = 5000
// Why looser but still bounded: the relay adds a round trip a local spawn does not have, and the
// budget must stay under the multiplexer's 30s request timeout so this deadline is the one that fires.
const SSH_PROBE_TIMEOUT_MS = 20_000

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

export async function probeGitRemoteIdentity(
  repoPath: string,
  executionHostId: ExecutionHostId,
  options: GitRemoteIdentityProbeOptions = {}
): Promise<GitRemoteIdentityProbe> {
  try {
    // Inside the try on purpose: an id naming no host must land on `unavailable` like every other
    // probe that never reached git. It must never become the local answer for a remote path.
    const route = resolveGitRouteForHost(executionHostId)
    if (route.kind === 'runtime') {
      // That environment's server runs its own git, and the SSH target on its repo row is nested in
      // that server's namespace — dialing it here answers for a same-named box of ours.
      return { status: 'unavailable' }
    }
    const result =
      route.kind === 'ssh'
        ? await route.provider?.exec(['remote', '-v'], repoPath, {
            signal: options.signal,
            timeoutMs: options.timeoutMs ?? SSH_PROBE_TIMEOUT_MS
          })
        : await gitExecFileAsync(['remote', '-v'], {
            cwd: repoPath,
            timeout: options.timeoutMs ?? LOCAL_PROBE_TIMEOUT_MS,
            signal: options.signal
          })
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
