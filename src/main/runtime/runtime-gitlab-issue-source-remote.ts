import type { Repo } from '../../shared/repo-types'
import { getDefaultRemote } from '../git/repo'
import { getProjectRefForRemote } from '../gitlab/client'
import { getGlabKnownHosts } from '../gitlab/gl-utils'

export async function resolveRuntimeGitLabIssueSourceRemote(
  repoPath: string,
  preference?: Repo['issueSourcePreference'],
  localGitOptions: { wslDistro?: string } = {}
): Promise<string> {
  const knownHosts = await getGlabKnownHosts(null, localGitOptions)
  const localGitOptionArgs =
    Object.keys(localGitOptions).length > 0 ? ([localGitOptions] as const) : []
  const resolveProject = (remote: string) =>
    getProjectRefForRemote(repoPath, remote, knownHosts, null, ...localGitOptionArgs)
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
  return getDefaultRemote(repoPath, localGitOptions)
}
