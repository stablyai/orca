import type { Repo } from '../../shared/repo-types'
import { getDefaultRemote } from '../git/repo'
import { getProjectRefForRemote } from '../gitlab/client'
import { getGlabKnownHosts } from '../gitlab/gl-utils'
import { requireSshGitProvider } from '../providers/ssh-git-dispatch'
import { pickPreferredGitRemote } from '../../shared/preferred-git-remote'

export async function resolveRuntimeGitLabIssueSourceRemote(
  repoPath: string,
  preference?: Repo['issueSourcePreference'],
  connectionId?: string | null,
  localGitOptions: { wslDistro?: string } = {}
): Promise<string> {
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
  const localGitOptionArgs =
    Object.keys(localGitOptions).length > 0 ? ([localGitOptions] as const) : []
  const resolveProject = (remote: string) =>
    getProjectRefForRemote(repoPath, remote, knownHosts, connectionId, ...localGitOptionArgs)
  if (preference === 'origin') {
    if (await resolveProject('origin')) {
      return 'origin'
    }
    throw new Error('No GitLab project found for origin.')
  }
  if (preference === 'upstream') {
    if (await resolveProject('upstream')) {
      return 'upstream'
    }
    if (await resolveProject('origin')) {
      return 'origin'
    }
    throw new Error('No GitLab project found for upstream or origin.')
  }
  if (await resolveProject('upstream')) {
    return 'upstream'
  }
  if (await resolveProject('origin')) {
    return 'origin'
  }
  if (connectionId) {
    const provider = requireSshGitProvider(connectionId)
    const { stdout } = await provider.exec(['remote'], repoPath)
    return pickPreferredGitRemote(stdout.split('\n'))
  }
  return getDefaultRemote(repoPath, localGitOptions)
}
