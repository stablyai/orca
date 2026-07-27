import { deriveGitRemoteIdentities, type GitRemoteIdentity } from '../shared/git-remote-identity'
import { gitExecFileAsync } from './git/runner'
import { getSshGitProvider } from './providers/ssh-git-dispatch'

/** `no-remote` means git answered and the repo has no usable remote;
 *  `unavailable` means the probe never reached git (host down, SSH not up
 *  yet, git error, timeout) and says nothing about the repo. */
export type GitRemoteIdentityProbe =
  /** `remotes[0]` is `identity`; the rest are the repo's other canonical remotes. */
  | { status: 'resolved'; identity: GitRemoteIdentity; remotes: GitRemoteIdentity[] }
  | { status: 'no-remote' }
  | { status: 'unavailable' }

export type GitRemoteIdentityProbeOptions = {
  /** Bounds the git call; a timeout degrades to `unavailable`. Unset = unbounded. */
  timeoutMs?: number
}

// Spread at each use: callees take a mutable `string[]`, so never hand out this shared array.
const GIT_REMOTE_VERBOSE_ARGS = ['remote', '-v'] as const

async function execGitRemoteVerbose(
  repoPath: string,
  connectionId: string | null | undefined,
  timeoutMs: number | undefined
): Promise<{ stdout: string } | undefined> {
  if (connectionId) {
    const provider = getSshGitProvider(connectionId)
    if (!provider) {
      return undefined
    }
    return timeoutMs === undefined
      ? await provider.exec([...GIT_REMOTE_VERBOSE_ARGS], repoPath)
      : await provider.exec([...GIT_REMOTE_VERBOSE_ARGS], repoPath, { timeoutMs })
  }
  return await gitExecFileAsync([...GIT_REMOTE_VERBOSE_ARGS], {
    cwd: repoPath,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs })
  })
}

export async function probeGitRemoteIdentity(
  repoPath: string,
  connectionId?: string | null,
  options?: GitRemoteIdentityProbeOptions
): Promise<GitRemoteIdentityProbe> {
  try {
    const result = await execGitRemoteVerbose(repoPath, connectionId, options?.timeoutMs)
    if (!result) {
      return { status: 'unavailable' }
    }
    const remotes = deriveGitRemoteIdentities(result.stdout)
    const identity = remotes[0]
    return identity ? { status: 'resolved', identity, remotes } : { status: 'no-remote' }
  } catch {
    // Repo creation must not fail because a best-effort remote probe failed.
    return { status: 'unavailable' }
  }
}

export async function detectGitRemoteIdentity(
  repoPath: string,
  connectionId?: string | null
): Promise<GitRemoteIdentity | null> {
  const probe = await probeGitRemoteIdentity(repoPath, connectionId)
  return probe.status === 'resolved' ? probe.identity : null
}
