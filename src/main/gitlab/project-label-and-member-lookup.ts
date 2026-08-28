import type { GitLabAssignableUser } from '../../shared/gitlab-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import {
  acquire,
  getGlabKnownHosts,
  glabExecFileAsync,
  glabHostnameArgs,
  glabRepoExecOptions,
  release,
  resolveIssueSource,
  type LocalGitExecOptions
} from './gl-utils'
import { encodedProject } from './project-path-encoding'

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
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        '--paginate',
        `projects/${encodedProject(projectRef.path)}/labels`,
        '--jq',
        '.[].name'
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    return stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
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
    // Why: `members/all` returns project members including those inherited
    // from parent groups — important for projects under a top-level group
    // where assignable users typically come from the group, not the project.
    // --paginate walks every page; --jq emits NDJSON.
    const { stdout } = await glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        '--paginate',
        `projects/${encodedProject(projectRef.path)}/members/all?per_page=100`,
        '--jq',
        '.[] | {id, username, name, avatar_url, state}'
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    type RESTMember = {
      id?: number
      username?: string
      name?: string | null
      avatar_url?: string | null
      state?: string | null
    }
    const users: GitLabAssignableUser[] = []
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }
      try {
        const user = JSON.parse(trimmed) as RESTMember
        if (user.username) {
          users.push({
            ...(typeof user.id === 'number' ? { id: user.id } : {}),
            username: user.username,
            name: user.name ?? null,
            avatarUrl: user.avatar_url ?? '',
            ...(user.state !== undefined ? { state: user.state } : {})
          })
        }
      } catch {
        // Skip malformed NDJSON lines defensively.
      }
    }
    return users
  } catch {
    return []
  } finally {
    release()
  }
}
