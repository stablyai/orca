import { assertPositiveInt, projectGhExecOptions, runRest, validateSlugArgs } from './internals'
import type { PRComment } from '../../../shared/github/comment-types'
import type {
  GitHubProjectCommentMutationResult,
  GitHubProjectMutationResult
} from '../../../shared/github/project-result-types'
import type {
  AddIssueCommentBySlugArgs,
  DeleteIssueCommentBySlugArgs,
  UpdateIssueCommentBySlugArgs
} from '../../../shared/github/project-request-types'

type RawIssueCommentResponse = {
  id?: number
  user?: { login?: string; avatar_url?: string; type?: string } | null
  body?: string
  created_at?: string
  html_url?: string
}

function mapIssueComment(data: RawIssueCommentResponse, fallbackBody: string): PRComment {
  return {
    id: data.id ?? Date.now(),
    author: data.user?.login ?? 'You',
    authorAvatarUrl: data.user?.avatar_url ?? '',
    body: data.body ?? fallbackBody,
    createdAt: data.created_at ?? new Date().toISOString(),
    url: data.html_url ?? '',
    isBot: data.user?.type === 'Bot'
  }
}

export async function addIssueCommentBySlug(
  args: AddIssueCommentBySlugArgs
): Promise<GitHubProjectCommentMutationResult> {
  const slug = validateSlugArgs(args.owner, args.repo)
  if (!slug.ok) {
    return slug
  }
  const number = assertPositiveInt(args.number, 'number')
  if (!number.ok) {
    return { ok: false, error: number.error }
  }
  if (typeof args.body !== 'string' || !args.body.trim()) {
    return { ok: false, error: { type: 'validation_error', message: 'Comment body required.' } }
  }
  const result = await runRest<RawIssueCommentResponse>(
    [
      '-X',
      'POST',
      `repos/${args.owner}/${args.repo}/issues/${args.number}/comments`,
      '--raw-field',
      `body=${args.body}`
    ],
    undefined,
    'core',
    projectGhExecOptions(args.host)
  )
  return result.ok
    ? { ok: true, comment: mapIssueComment(result.data, args.body) }
    : { ok: false, error: result.error }
}

export async function updateIssueCommentBySlug(
  args: UpdateIssueCommentBySlugArgs
): Promise<GitHubProjectMutationResult> {
  const slug = validateSlugArgs(args.owner, args.repo)
  if (!slug.ok) {
    return slug
  }
  const number = assertPositiveInt(args.commentId, 'commentId')
  if (!number.ok) {
    return { ok: false, error: number.error }
  }
  if (typeof args.body !== 'string' || !args.body.trim()) {
    return { ok: false, error: { type: 'validation_error', message: 'Comment body required.' } }
  }
  const result = await runRest<unknown>(
    [
      '-X',
      'PATCH',
      `repos/${args.owner}/${args.repo}/issues/comments/${args.commentId}`,
      '--raw-field',
      `body=${args.body}`
    ],
    undefined,
    'core',
    projectGhExecOptions(args.host)
  )
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

export async function deleteIssueCommentBySlug(
  args: DeleteIssueCommentBySlugArgs
): Promise<GitHubProjectMutationResult> {
  const slug = validateSlugArgs(args.owner, args.repo)
  if (!slug.ok) {
    return slug
  }
  const number = assertPositiveInt(args.commentId, 'commentId')
  if (!number.ok) {
    return { ok: false, error: number.error }
  }
  const result = await runRest<unknown>(
    ['-X', 'DELETE', `repos/${args.owner}/${args.repo}/issues/comments/${args.commentId}`],
    undefined,
    'core',
    { expectEmpty: true, ...projectGhExecOptions(args.host) }
  )
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}
