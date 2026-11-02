import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'
import { deriveGitRemoteIdentity, type GitRemoteIdentity } from '../shared/git-remote-identity'
import { gitExecFileAsync } from './git/runner'
import { resolveGitRouteForHost } from './providers/execution-host-provider-dispatch'

// Bound probes on hung network mounts or WSL; timeouts remain unavailable and retry later.
const LOCAL_PROBE_TIMEOUT_MS = 5000

export type GitRemoteIdentityProbeOptions = {
  signal?: AbortSignal
  timeoutMs?: number
  /** The distro a local project's runtime runs Git in. */
  wslDistro?: string
  /** Before the project exists: its remote is read with the host's Git. */
  hostGit?: true
  /** A sweep's read waits for a stopped distro rather than booting it. */
  admissionTier?: 'background'
}

/** no-remote proves absence; unavailable leaves the repo identity unknown. */
export type GitRemoteIdentityProbe =
  | { status: 'resolved'; identity: GitRemoteIdentity }
  | { status: 'no-remote' }
  | { status: 'unavailable' }

/** Resolves null for unserved hosts; git errors reject. */
export async function runGitProbeOnHost(
  args: string[],
  repoPath: string,
  executionHostId: ExecutionHostId,
  options: GitRemoteIdentityProbeOptions = {}
): Promise<{ stdout: string } | null> {
  // Runtime and SSH targets must not fall back to this machine's git.
  if (resolveGitRouteForHost(executionHostId).kind !== 'local') {
    return null
  }
  return gitExecFileAsync(args, {
    cwd: repoPath,
    timeout: options.timeoutMs ?? LOCAL_PROBE_TIMEOUT_MS,
    signal: options.signal,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.hostGit ? { hostGit: options.hostGit } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
  })
}

export async function probeGitRemoteIdentity(
  repoPath: string,
  executionHostId: ExecutionHostId,
  options: GitRemoteIdentityProbeOptions = {}
): Promise<GitRemoteIdentityProbe> {
  try {
    // Route errors also mean unavailable, never a local answer for a remote path.
    const result = await runGitProbeOnHost(['remote', '-v'], repoPath, executionHostId, options)
    if (!result) {
      return { status: 'unavailable' }
    }
    const identity = deriveGitRemoteIdentity(result.stdout)
    return identity ? { status: 'resolved', identity } : { status: 'no-remote' }
  } catch {
    // Probe failures must not fail repo creation or clear a known identity.
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

export async function readCurrentGitRemoteIdentity(
  repo: Pick<Repo, 'path' | 'kind' | 'gitRemoteIdentity'>
): Promise<Pick<Repo, 'gitRemoteIdentity'>> {
  if (repo.kind === 'folder') {
    return { gitRemoteIdentity: null }
  }
  // Both setup paths register files in this process.
  const probe = await probeGitRemoteIdentity(repo.path, LOCAL_EXECUTION_HOST_ID)
  if (probe.status === 'resolved') {
    return { gitRemoteIdentity: probe.identity }
  }
  return { gitRemoteIdentity: probe.status === 'no-remote' ? null : repo.gitRemoteIdentity }
}
