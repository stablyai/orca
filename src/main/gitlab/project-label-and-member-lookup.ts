import type { GitLabAssignableUser } from '../../shared/gitlab-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import { mapGitLabUser, type GitLabRawUser } from './gitlab-assignable-user-mapping'
import {
  acquire,
  getGlabKnownHosts,
  release,
  resolveIssueSource,
  type LocalGitExecOptions
} from './gl-utils'
import { fetchAllGitLabPages } from './gitlab-paginated-list'
import { encodedProject } from './project-path-encoding'

type GitLabRawLabel = { name?: string | null } | null

export async function listLabels(
  repoPath: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<string[]> {
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
  const { source: projectRef } = await resolveIssueSource(
    repoPath,
    preference,
    knownHosts,
    connectionId,
    localGitOptions
  )
  if (!projectRef) {
    return []
  }
  await acquire()
  try {
    const labels = await fetchAllGitLabPages<GitLabRawLabel>(
      repoPath,
      projectRef,
      `projects/${encodedProject(projectRef.path)}/labels`,
      connectionId,
      localGitOptions
    )
    return labels.flatMap((label) => (label?.name ? [label.name] : []))
  } catch {
    return []
  } finally {
    release()
  }
}

export async function listAssignableUsers(
  repoPath: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabAssignableUser[]> {
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
  const { source: projectRef } = await resolveIssueSource(
    repoPath,
    preference,
    knownHosts,
    connectionId,
    localGitOptions
  )
  if (!projectRef) {
    return []
  }
  await acquire()
  try {
    // Include members inherited from parent groups, where assignable project users commonly originate.
    const members = await fetchAllGitLabPages<GitLabRawUser | null>(
      repoPath,
      projectRef,
      `projects/${encodedProject(projectRef.path)}/members/all`,
      connectionId,
      localGitOptions
    )
    return members.map(mapGitLabUser).filter((user): user is GitLabAssignableUser => user !== null)
  } catch {
    return []
  } finally {
    release()
  }
}
