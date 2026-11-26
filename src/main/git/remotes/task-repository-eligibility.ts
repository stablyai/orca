import { parseGitRemoteVerboseOutput } from '../../../shared/git/remotes/git-remote-identity'
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
  gitHubSshConfigHostAlias,
  parseGitHubRemoteIdentity,
  rawSshTransportHost
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
  // An SSH alias cannot be ruled out without expanding it in the repo runtime; unknown stays visible.
  if (gitHubSshConfigHostAlias(remoteUrl) ?? rawSshTransportHost(remoteUrl)) {
    return 'unknown'
  }
  const url = remoteUrl

  const identity = parseGitHubRemoteIdentity(url)
  if (
    identity &&
    (isDefaultGitHubHost(identity.host) ||
      (await isGitHubHostAuthenticated(identity.host, repoPath, null, localGitOptions)))
  ) {
    return 'github'
  }
  const gitlabRef =
    provider === 'github'
      ? parseGitLabProjectRef(url, gitLabHosts)
      : parseGitLabProjectRefCandidate(url)
  if (gitlabRef) {
    return 'gitlab'
  }
  return parseRemoteProjectRefCandidate(url) ? 'non-github' : 'unknown'
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
