import { parseGitRemoteVerboseOutput } from '../../shared/git-remote-identity'
import { isDefaultGitHubHost } from '../../shared/github/repository-identity-key'
import { isGitHubHostAuthenticated } from '../github/github-enterprise-repository'
import { parseGitHubRemoteIdentity } from '../github/github-remote-identity-parsing'
import { parseGitLabProjectRef } from '../gitlab/project-ref-parser'
import { REMOTE_URL_PROBE_TIMEOUT_MS } from './remote-url-probe'
import { gitExecFileAsync } from './runner'
import type { RemoteRefLocalGitOptions } from './remote-ref-probe-cache'

/** Call only after the requested provider found no usable source; unknown is never exclusion evidence. */
export async function isTaskRepositoryIneligible(
  repoPath: string,
  provider: 'github' | 'gitlab',
  connectionId?: string | null,
  localGitOptions: RemoteRefLocalGitOptions = {}
): Promise<boolean> {
  if (connectionId) {
    return false
  }
  try {
    // Read the complete current set: a cached primary remote cannot rule out a matching upstream or extra remote.
    const { stdout } = await gitExecFileAsync(['remote', '-v'], {
      cwd: repoPath,
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS,
      ...localGitOptions
    })
    const remotes = parseGitRemoteVerboseOutput(stdout)
    if (remotes.length === 0) {
      return false
    }
    for (const remote of remotes) {
      if (provider === 'github') {
        if (!parseGitLabProjectRef(remote.url)) {
          return false
        }
      } else {
        const identity = parseGitHubRemoteIdentity(remote.url)
        if (
          !identity ||
          (!isDefaultGitHubHost(identity.host) &&
            !(await isGitHubHostAuthenticated(identity.host, repoPath, null, localGitOptions)))
        ) {
          return false
        }
      }
    }
    return true
  } catch {
    return false
  }
}
