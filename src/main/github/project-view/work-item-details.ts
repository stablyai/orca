import { assertPositiveInt, projectGhExecOptions, runGraphql, validateSlugArgs } from './internals'
import type { PRComment } from '../../../shared/github/comment-types'
import type { GitHubAssignableUser } from '../../../shared/github/pull-request-types'
import type { GitHubWorkItemDetails } from '../../../shared/github/work-item-types'
import type { ProjectWorkItemDetailsBySlugResult } from '../../../shared/github/project-result-types'
import type { ProjectWorkItemDetailsBySlugArgs } from '../../../shared/github/project-request-types'

type RawUser = { login?: string; name?: string | null; avatarUrl?: string | null }
type RawLabel = { name?: string; color?: string }
type RawComment = {
  databaseId?: number
  author?: { login?: string; avatarUrl?: string; __typename?: string } | null
  body?: string
  createdAt?: string
  url?: string
}
type RawWorkItemContent = {
  id?: string
  number?: number
  title?: string
  url?: string
  state?: string
  stateReason?: string | null
  isDraft?: boolean
  updatedAt?: string
  body?: string
  headRefName?: string
  baseRefName?: string
  author?: { login?: string } | null
  labels?: { nodes?: RawLabel[] }
  assignees?: { nodes?: RawUser[] }
  participants?: { nodes?: RawUser[] }
  comments?: { nodes?: (RawComment | null)[] }
}

export async function getWorkItemDetailsBySlug(
  args: ProjectWorkItemDetailsBySlugArgs
): Promise<ProjectWorkItemDetailsBySlugResult> {
  const validation = validateSlugArgs(args.owner, args.repo)
  if (!validation.ok) {
    return validation
  }
  const number = assertPositiveInt(args.number, 'number')
  if (!number.ok) {
    return { ok: false, error: number.error }
  }
  if (args.type !== 'issue' && args.type !== 'pr') {
    return { ok: false, error: { type: 'validation_error', message: 'Invalid type.' } }
  }
  const contentFragment = args.type === 'issue' ? ISSUE_FRAGMENT : PULL_REQUEST_FRAGMENT
  const result = await runGraphql<{
    repository?: {
      issue?: RawWorkItemContent | null
      pullRequest?: RawWorkItemContent | null
    } | null
  }>(
    `query($owner:String!, $repo:String!, $num:Int!) {
       repository(owner:$owner, name:$repo) { ${contentFragment} }
     }`,
    { owner: args.owner, repo: args.repo, num: args.number },
    projectGhExecOptions(args.host)
  )
  if (!result.ok) {
    return { ok: false, error: result.error }
  }
  const raw =
    args.type === 'issue' ? result.data.repository?.issue : result.data.repository?.pullRequest
  if (!raw) {
    return { ok: false, error: { type: 'not_found', message: 'Item not found.' } }
  }
  return { ok: true, details: mapWorkItemDetails(raw, args) }
}

const ISSUE_FRAGMENT = `issue(number:$num) {
  id number title url state stateReason updatedAt body author { login }
  labels(first:50) { nodes { name } }
  assignees(first:50) { nodes { login } }
  participants(first:50) { nodes { login name avatarUrl } }
  comments(first:100) {
    nodes { databaseId author { login avatarUrl __typename } body createdAt url }
  }
}`

const PULL_REQUEST_FRAGMENT = `pullRequest(number:$num) {
  id number title url state isDraft updatedAt headRefName baseRefName body author { login }
  labels(first:50) { nodes { name } }
  assignees(first:50) { nodes { login } }
  participants(first:50) { nodes { login name avatarUrl } }
  comments(first:100) {
    nodes { databaseId author { login avatarUrl __typename } body createdAt url }
  }
}`

function mapWorkItemDetails(
  raw: RawWorkItemContent,
  args: ProjectWorkItemDetailsBySlugArgs
): GitHubWorkItemDetails {
  const labels = (raw.labels?.nodes ?? [])
    .map((label) => label?.name)
    .filter((name): name is string => typeof name === 'string')
  const assignees = (raw.assignees?.nodes ?? [])
    .map((assignee) => assignee?.login)
    .filter((login): login is string => typeof login === 'string')
  const comments: PRComment[] = []
  for (const comment of raw.comments?.nodes ?? []) {
    if (!comment || typeof comment.body !== 'string') {
      continue
    }
    comments.push({
      id: typeof comment.databaseId === 'number' ? comment.databaseId : Date.now(),
      author: comment.author?.login ?? '',
      authorAvatarUrl: comment.author?.avatarUrl ?? '',
      body: comment.body,
      createdAt: typeof comment.createdAt === 'string' ? comment.createdAt : '',
      url: typeof comment.url === 'string' ? comment.url : '',
      isBot: comment.author?.__typename === 'Bot'
    })
  }
  const participants: GitHubAssignableUser[] = []
  for (const participant of raw.participants?.nodes ?? []) {
    if (participant && typeof participant.login === 'string') {
      participants.push({
        login: participant.login,
        name: participant.name ?? null,
        avatarUrl: participant.avatarUrl ?? ''
      })
    }
  }
  const state: 'open' | 'closed' | 'merged' | 'draft' =
    args.type === 'pr'
      ? raw.isDraft
        ? 'draft'
        : raw.state === 'MERGED'
          ? 'merged'
          : raw.state === 'CLOSED'
            ? 'closed'
            : 'open'
      : raw.state === 'CLOSED'
        ? 'closed'
        : 'open'
  return {
    item: {
      id: typeof raw.id === 'string' ? raw.id : '',
      type: args.type,
      number: typeof raw.number === 'number' ? raw.number : args.number,
      title: typeof raw.title === 'string' ? raw.title : '',
      state,
      url: typeof raw.url === 'string' ? raw.url : '',
      labels,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      author: typeof raw.author?.login === 'string' ? raw.author.login : null,
      branchName:
        args.type === 'pr' && typeof raw.headRefName === 'string' ? raw.headRefName : undefined,
      baseRefName:
        args.type === 'pr' && typeof raw.baseRefName === 'string' ? raw.baseRefName : undefined
    },
    body: typeof raw.body === 'string' ? raw.body : '',
    comments,
    participants,
    assignees
  }
}
