import type { PRComment } from '../../shared/github/comment-types'
import type { GitHubAssignableUser } from '../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../shared/github/work-item-types'
import { ghExecFileAsync, ghRepoExecOptions, githubRepoContext } from './gh-utils'
import type { LocalGitExecOptions } from './gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from './github-api-repository'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from './rate-limit'

const WORK_ITEM_PARTICIPANTS_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $isPr: Boolean!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) @include(if: $isPr) {
      participants(first: 100) {
        nodes { login avatarUrl(size: 48) ... on User { name } }
      }
    }
    issue(number: $number) @skip(if: $isPr) {
      participants(first: 100) {
        nodes { login avatarUrl(size: 48) ... on User { name } }
      }
    }
  }
}`

function mergeGitHubUsers(users: GitHubAssignableUser[]): GitHubAssignableUser[] {
  const byLogin = new Map<string, GitHubAssignableUser>()
  for (const user of users) {
    if (!user.login) {
      continue
    }
    const key = user.login.toLowerCase()
    const existing = byLogin.get(key)
    if (existing) {
      byLogin.set(key, {
        login: existing.login,
        name: existing.name ?? user.name ?? null,
        avatarUrl: existing.avatarUrl || user.avatarUrl || ''
      })
      continue
    }
    byLogin.set(key, {
      login: user.login,
      name: user.name ?? null,
      avatarUrl: user.avatarUrl ?? ''
    })
  }
  return Array.from(byLogin.values())
}

export async function getWorkItemParticipants(
  repoPath: string,
  item: Pick<GitHubWorkItem, 'number' | 'type'>,
  repository: GitHubApiRepository | null,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubAssignableUser[]> {
  if (!repository) {
    return []
  }
  const ghOptions = {
    ...ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions)),
    ...githubHostExecOptions(repository)
  }
  if (repositoryRateLimitGuard(repository, 'graphql', ghOptions).blocked) {
    return []
  }
  try {
    noteRepositoryRateLimitSpend(repository, 'graphql', 1, ghOptions)
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        'graphql',
        '-f',
        `query=${WORK_ITEM_PARTICIPANTS_QUERY}`,
        '-f',
        `owner=${repository.owner}`,
        '-f',
        `repo=${repository.repo}`,
        '-F',
        `number=${item.number}`,
        '-F',
        `isPr=${item.type === 'pr'}`
      ],
      ghOptions
    )
    const data = JSON.parse(stdout) as {
      data?: {
        repository?: {
          pullRequest?: { participants?: { nodes?: GitHubAssignableUser[] } } | null
          issue?: { participants?: { nodes?: GitHubAssignableUser[] } } | null
        }
      }
    }
    const nodes =
      data.data?.repository?.pullRequest?.participants?.nodes ??
      data.data?.repository?.issue?.participants?.nodes ??
      []
    return nodes
      .map((user) => ({
        login: user.login,
        name: user.name ?? null,
        avatarUrl: user.avatarUrl ?? ''
      }))
      .filter((user) => user.login)
  } catch {
    return []
  }
}

async function getGitHubUsersByLogin(
  repoPath: string,
  logins: string[],
  repository: GitHubApiRepository | null,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubAssignableUser[]> {
  if (!repository) {
    return []
  }
  const uniqueLogins = Array.from(
    new Set(logins.filter((login) => login && login !== 'ghost').map((login) => login.trim()))
  ).slice(0, 40)
  if (uniqueLogins.length === 0) {
    return []
  }
  const ghOptions = {
    ...ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions)),
    ...githubHostExecOptions(repository)
  }
  if (repositoryRateLimitGuard(repository, 'graphql', ghOptions).blocked) {
    console.warn(
      `getGitHubUsersByLogin skipped: GraphQL rate-limit budget exhausted (${uniqueLogins.length} logins unresolved)`
    )
    return []
  }
  const fields = uniqueLogins
    .map(
      (login, index) =>
        `u${index}: user(login: ${JSON.stringify(login)}) { login name avatarUrl(size: 48) }`
    )
    .join('\n')
  try {
    noteRepositoryRateLimitSpend(repository, 'graphql', 1, ghOptions)
    const { stdout } = await ghExecFileAsync(
      ['api', 'graphql', '-f', `query=query { ${fields} }`],
      ghOptions
    )
    const data = JSON.parse(stdout) as {
      data?: Record<
        string,
        { login?: string; name?: string | null; avatarUrl?: string | null } | null
      >
    }
    return Object.values(data.data ?? {})
      .filter((user): user is { login: string; name?: string | null; avatarUrl?: string | null } =>
        Boolean(user?.login)
      )
      .map((user) => ({
        login: user.login,
        name: user.name ?? null,
        avatarUrl: user.avatarUrl ?? ''
      }))
  } catch {
    return []
  }
}

export async function getMentionParticipants(
  repoPath: string,
  item: Pick<
    GitHubWorkItem,
    'author' | 'number' | 'type' | 'reviewRequests' | 'latestReviews' | 'assignees'
  >,
  comments: PRComment[],
  participants: GitHubAssignableUser[],
  repository: GitHubApiRepository | null,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubAssignableUser[]> {
  const visibleLogins = [
    item.author ?? '',
    ...(item.reviewRequests ?? []).map((user) => user.login),
    ...(item.latestReviews ?? []).map((review) => review.login),
    ...(item.assignees ?? []).map((user) => user.login),
    ...comments.map((comment) => comment.author)
  ]
  const graphQlUsers = await getGitHubUsersByLogin(
    repoPath,
    visibleLogins,
    repository,
    connectionId,
    localGitOptions
  )
  return mergeGitHubUsers([...participants, ...graphQlUsers])
}

export function enrichItemDisplayAvatars(
  item: Omit<GitHubWorkItem, 'repoId'>,
  knownUsers: GitHubAssignableUser[]
): Omit<GitHubWorkItem, 'repoId'> {
  const avatarByLogin = new Map<string, string>()
  for (const user of knownUsers) {
    if (user.login && user.avatarUrl) {
      avatarByLogin.set(user.login.toLowerCase(), user.avatarUrl)
    }
  }
  if (avatarByLogin.size === 0) {
    return item
  }
  const avatarFor = (login: string): string | undefined => avatarByLogin.get(login.toLowerCase())
  const resolvedAvatar = (login: string, existing?: string | null): string | undefined =>
    avatarFor(login) || existing || undefined
  const authorAvatarUrl = (item.author ? avatarFor(item.author) : undefined) || item.authorAvatarUrl
  return {
    ...item,
    ...(authorAvatarUrl ? { authorAvatarUrl } : {}),
    ...(item.reviewRequests
      ? {
          reviewRequests: item.reviewRequests.map((user) => ({
            ...user,
            avatarUrl: resolvedAvatar(user.login, user.avatarUrl) ?? ''
          }))
        }
      : {}),
    ...(item.latestReviews
      ? {
          latestReviews: item.latestReviews.map((review) => ({
            ...review,
            avatarUrl: resolvedAvatar(review.login, review.avatarUrl) ?? null
          }))
        }
      : {}),
    ...(item.assignees
      ? {
          assignees: item.assignees.map((user) => ({
            ...user,
            avatarUrl: resolvedAvatar(user.login, user.avatarUrl) ?? ''
          }))
        }
      : {})
  }
}
