import type { GitLabAssignableUser } from '../../shared/gitlab-types'

export type GitLabRawUser = {
  id?: number
  username?: string | null
  name?: string | null
  avatar_url?: string | null
  state?: string | null
}

export function mapGitLabUser(raw: GitLabRawUser | null | undefined): GitLabAssignableUser | null {
  if (!raw?.username) {
    return null
  }
  return {
    ...(typeof raw.id === 'number' ? { id: raw.id } : {}),
    username: raw.username,
    name: raw.name ?? null,
    avatarUrl: raw.avatar_url ?? '',
    ...(raw.state !== undefined ? { state: raw.state } : {})
  }
}
