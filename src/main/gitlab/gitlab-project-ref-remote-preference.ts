import { gitExecFileAsync } from '../git/runner'
import { REMOTE_URL_PROBE_TIMEOUT_MS } from '../git/remote-url-probe'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import type { LocalGitExecOptions } from './gitlab-known-host-probe'

/**
 * Prefer named remotes (origin/upstream), then any other configured remote.
 * Keeps the historical origin/upstream tie-break while fixing repos that only
 * have a non-conventionally named GitLab remote (#13816).
 */
export async function resolveProjectRefPreferringRemotes<T>(
  preferredRemoteNames: readonly string[],
  probeRemote: (remoteName: string) => Promise<T | null>,
  listRemoteNames: () => Promise<readonly string[]>
): Promise<T | null> {
  const seen = new Set<string>()
  for (const remoteName of preferredRemoteNames) {
    if (!remoteName || seen.has(remoteName)) continue
    seen.add(remoteName)
    const ref = await probeRemote(remoteName)
    if (ref) return ref
  }
  for (const remoteName of await listRemoteNames()) {
    if (seen.has(remoteName)) continue
    seen.add(remoteName)
    const ref = await probeRemote(remoteName)
    if (ref) return ref
  }
  return null
}

export function parseGitRemoteNames(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** List configured remote names (local git or SSH provider). Empty on failure. */
export async function listRepoRemoteNames(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<string[]> {
  try {
    if (connectionId) {
      const provider = getSshGitProvider(connectionId)
      if (!provider) return []
      const { stdout } = await provider.exec(['remote'], repoPath, {
        signal: AbortSignal.timeout(REMOTE_URL_PROBE_TIMEOUT_MS)
      })
      return parseGitRemoteNames(stdout)
    }
    const { stdout } = await gitExecFileAsync(['remote'], {
      cwd: repoPath,
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS,
      ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
    })
    return parseGitRemoteNames(stdout)
  } catch {
    return []
  }
}
