import type { GitHubIssueTimelineItem, PRComment } from '../../shared/github/comment-types'
import type { GitHubAssignableUser } from '../../shared/github/pull-request-types'
import { ghExecFileAsync, ghRepoExecOptions, githubRepoContext } from './gh-utils'
import type { LocalGitExecOptions } from './gh-utils'
import { githubHostExecOptions, type GitHubApiRepository } from './github-api-repository'
import { getIssueTimelineItems } from './issue-timeline'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from './rate-limit'

const ISSUE_DETAILS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      body
      assignees(first: 50) { nodes { login avatarUrl(size: 48) ... on User { name } } }
      participants(first: 100) {
        nodes { login avatarUrl(size: 48) ... on User { name } }
      }
      comments(first: 100) {
        nodes {
          databaseId
          body
          createdAt
          url
          author {
            login
            avatarUrl(size: 48)
            ... on Bot { __typename }
          }
        }
      }
    }
  }
}`

type GraphQLIssueDetailsResponse = {
  data?: {
    repository?: {
      issue?: {
        body?: string | null
        assignees?: { nodes?: { login?: string; avatarUrl?: string; name?: string | null }[] }
        participants?: { nodes?: GitHubAssignableUser[] }
        comments?: {
          nodes?: {
            databaseId?: number | null
            body?: string | null
            createdAt?: string | null
            url?: string | null
            author?: {
              login?: string | null
              avatarUrl?: string | null
              __typename?: string
            } | null
          }[]
        }
      } | null
    } | null
  }
  errors?: { message?: string }[]
}

export type CollapsedIssueDetails = {
  body: string
  comments: PRComment[]
  assignees: string[]
  assigneeUsers: GitHubAssignableUser[]
  participants: GitHubAssignableUser[]
  timelineItems: GitHubIssueTimelineItem[]
}

export async function getIssueDetailsViaGraphQL(
  repoPath: string,
  issueNumber: number,
  repository: GitHubApiRepository | null,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<CollapsedIssueDetails | null> {
  const ghOptions = {
    ...ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions)),
    ...githubHostExecOptions(repository)
  }
  if (!repository) {
    return null
  }
  if (repositoryRateLimitGuard(repository, 'graphql', ghOptions).blocked) {
    return null
  }
  try {
    noteRepositoryRateLimitSpend(repository, 'graphql', 1, ghOptions)
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        'graphql',
        '-f',
        `query=${ISSUE_DETAILS_QUERY}`,
        '-f',
        `owner=${repository.owner}`,
        '-f',
        `repo=${repository.repo}`,
        '-F',
        `number=${issueNumber}`
      ],
      ghOptions
    )
    const parsed = JSON.parse(stdout) as GraphQLIssueDetailsResponse
    if (parsed.errors && parsed.errors.length > 0) {
      return null
    }
    const issue = parsed.data?.repository?.issue
    if (!issue) {
      return null
    }
    const comments: PRComment[] = (issue.comments?.nodes ?? [])
      .filter((comment) => typeof comment.databaseId === 'number')
      .map((comment) => ({
        id: comment.databaseId as number,
        author: comment.author?.login ?? 'ghost',
        authorAvatarUrl: comment.author?.avatarUrl ?? '',
        body: comment.body ?? '',
        createdAt: comment.createdAt ?? '',
        url: comment.url ?? '',
        isBot: comment.author?.__typename === 'Bot'
      }))
    const assigneeUsers: GitHubAssignableUser[] = (issue.assignees?.nodes ?? [])
      .filter((assignee): assignee is { login: string; avatarUrl?: string; name?: string | null } =>
        Boolean(assignee.login)
      )
      .map((assignee) => ({
        login: assignee.login,
        name: assignee.name ?? null,
        avatarUrl: assignee.avatarUrl ?? ''
      }))
    const participants: GitHubAssignableUser[] = (issue.participants?.nodes ?? [])
      .filter((user) => Boolean(user.login))
      .map((user) => ({
        login: user.login,
        name: user.name ?? null,
        avatarUrl: user.avatarUrl ?? ''
      }))
    return {
      body: issue.body ?? '',
      comments,
      assignees: assigneeUsers.map((assignee) => assignee.login),
      assigneeUsers,
      participants,
      timelineItems: await getIssueTimelineItems(repository, issueNumber, ghOptions)
    }
  } catch {
    return null
  }
}

export async function getIssueBodyAndComments(
  repoPath: string,
  issueNumber: number,
  repository: GitHubApiRepository | null,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{
  body: string
  comments: PRComment[]
  assignees: string[]
  timelineItems: GitHubIssueTimelineItem[]
}> {
  const ghOptions = {
    ...ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions)),
    ...githubHostExecOptions(repository)
  }
  try {
    if (repository) {
      if (repositoryRateLimitGuard(repository, 'core', ghOptions).blocked) {
        return { body: '', comments: [], assignees: [], timelineItems: [] }
      }
      noteRepositoryRateLimitSpend(repository, 'core', 2, ghOptions)
      const [issueResult, commentsResult, timelineItems] = await Promise.all([
        ghExecFileAsync(
          [
            'api',
            '--cache',
            '60s',
            `repos/${repository.owner}/${repository.repo}/issues/${issueNumber}`
          ],
          ghOptions
        ),
        ghExecFileAsync(
          [
            'api',
            '--cache',
            '60s',
            `repos/${repository.owner}/${repository.repo}/issues/${issueNumber}/comments?per_page=100`
          ],
          ghOptions
        ),
        getIssueTimelineItems(repository, issueNumber, ghOptions)
      ])
      const issue = JSON.parse(issueResult.stdout) as {
        body?: string | null
        assignees?: { login: string }[]
      }
      type RESTComment = {
        id: number
        user: { login: string; avatar_url: string; type?: string } | null
        body: string
        created_at: string
        html_url: string
      }
      const comments = (JSON.parse(commentsResult.stdout) as RESTComment[]).map(
        (comment): PRComment => ({
          id: comment.id,
          author: comment.user?.login ?? 'ghost',
          authorAvatarUrl: comment.user?.avatar_url ?? '',
          body: comment.body ?? '',
          createdAt: comment.created_at,
          url: comment.html_url,
          isBot: comment.user?.type === 'Bot'
        })
      )
      return {
        body: issue.body ?? '',
        comments,
        assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
        timelineItems
      }
    }
    if (connectionId) {
      // A connection-backed lookup must not use ambient local GH_REPO/GH_HOST.
      return { body: '', comments: [], assignees: [], timelineItems: [] }
    }
    const { stdout } = await ghExecFileAsync(
      ['issue', 'view', String(issueNumber), '--json', 'body,comments,assignees'],
      ghOptions
    )
    const data = JSON.parse(stdout) as {
      body?: string
      comments?: {
        author: { login: string }
        body: string
        createdAt: string
        url: string
      }[]
      assignees?: { login: string }[]
    }
    const comments = (data.comments ?? []).map(
      (comment, index): PRComment => ({
        id: index,
        author: comment.author?.login ?? 'ghost',
        authorAvatarUrl: '',
        body: comment.body ?? '',
        createdAt: comment.createdAt,
        url: comment.url ?? ''
      })
    )
    return {
      body: data.body ?? '',
      comments,
      assignees: (data.assignees ?? []).map((assignee) => assignee.login),
      timelineItems: []
    }
  } catch {
    return { body: '', comments: [], assignees: [], timelineItems: [] }
  }
}
