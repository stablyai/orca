import { parseGitRemoteVerboseOutput } from '../../../shared/git/remotes/git-remote-identity'
import { getPublicForgeProviderForHost } from '../../../shared/git/remotes/public-forge-host'
import { isDefaultGitHubHost } from '../../../shared/github/repositories/repository-identity-key'
import { isGitHubHostAuthenticated } from '../../github/repositories/github-enterprise-repository'
import {
  getGlabKnownHosts,
  getGlabPartialHosts
} from '../../gitlab/projects/gitlab-known-host-probe'
import {
  parseGitLabProjectRef,
  parseGitLabProjectRefCandidate,
  parseRemoteProjectRefCandidate
} from '../../gitlab/projects/project-ref-parser'
import {
  parseGitHubRemoteIdentity,
  remoteUrlUsesSshTransport
} from '../../github/repositories/github-remote-identity-parsing'
import { REMOTE_URL_PROBE_TIMEOUT_MS } from './remote-git-probe-timeout'
import { gitExecFileAsync } from '../command-runner/git-exec-file'
import type { RemoteRefLocalGitOptions } from './remote-ref-probe-cache'

type RemoteForgeEvidence = 'github' | 'gitlab' | 'non-github' | 'unknown'

async function resolveRemoteForgeEvidence(
  remoteUrl: string,
  provider: 'github' | 'gitlab',
  gitLabHosts: readonly string[],
  repoPath: string,
  localGitOptions: RemoteRefLocalGitOptions
): Promise<RemoteForgeEvidence> {
  const identity = parseGitHubRemoteIdentity(remoteUrl)

  // Direct github.com (HTTPS or SSH) must win before the SSH fallback.
  if (identity && isDefaultGitHubHost(identity.host)) {
    return 'github'
  }
  if (
    identity &&
    (await isGitHubHostAuthenticated(identity.host, repoPath, null, localGitOptions))
  ) {
    return 'github'
  }

  // A known GitLab host is affirmative evidence, including SSH to that host.
  const gitlabRef =
    provider === 'github'
      ? parseGitLabProjectRef(remoteUrl, gitLabHosts)
      : parseGitLabProjectRefCandidate(remoteUrl)
  if (gitlabRef) {
    return 'gitlab'
  }

  // A non-default SSH host may be an OpenSSH alias; do not rule out GitHub.
  if (remoteUrlUsesSshTransport(remoteUrl)) {
    return 'unknown'
  }

  const candidate = parseRemoteProjectRefCandidate(remoteUrl)
  const host = identity?.host ?? candidate?.host
  const knownForge = host ? getPublicForgeProviderForHost(host) : null
  if (knownForge && knownForge !== 'gitlab' && knownForge !== 'github') {
    return 'non-github'
  }

  // An unknown HTTP host may be GitHub Enterprise. Never exclusion evidence.
  return 'unknown'
}

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
    // A glab partial-auth failure (e.g. tokenless gitlab.com) still proves the hosts that did log in.
    const gitLabHosts =
      provider === 'github'
        ? [
            ...(await getGlabKnownHosts(connectionId, localGitOptions)),
            ...getGlabPartialHosts(connectionId, localGitOptions)
          ]
        : []
    const evidence = await Promise.all(
      remotes.map((remote) =>
        resolveRemoteForgeEvidence(remote.url, provider, gitLabHosts, repoPath, localGitOptions)
      )
    )
    if (provider === 'github') {
      return evidence.every((item) => item === 'gitlab' || item === 'non-github')
    }
    return evidence.every((item) => item === 'github')
  } catch {
    return false
  }
}
