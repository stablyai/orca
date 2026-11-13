import { githubBodyImageUrls, githubBodyMediaHeaders } from '../attachments/body-image-urls'
import { assertPositiveInt, validateSlugArgs } from './project-argument-validation'
import { projectGhExecOptions } from './project-host-execution'
import { runRest } from './project-rest'
import type { PRComment } from '../../../shared/github/comments/comment-types'
import type {
  GitHubProjectCommentMutationResult,
  GitHubProjectMutationResult
} from '../../../shared/github/projects/project-result-types'
import type {
  AddIssueCommentBySlugArgs,
  DeleteIssueCommentBySlugArgs,
  UpdateIssueCommentBySlugArgs
} from '../../../shared/github/projects/project-request-types'

type RawIssueCommentResponse = {
  id?: number
  user?: { login?: string; avatar_url?: string; type?: string } | null
  body?: string
  body_html?: string | null
  created_at?: string
  html_url?: string
}

function mapIssueComment(data: RawIssueCommentResponse, fallbackBody: string): PRComment {
  return {
    id: data.id ?? Date.now(),
    author: data.user?.login ?? 'You',
    authorAvatarUrl: data.user?.avatar_url ?? '',
    body: data.body ?? fallbackBody,
    bodyImageUrls: githubBodyImageUrls(data.body ?? fallbackBody, data.body_html),
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
    return {
      ok: false,
      error: {
        type: 'validation_error',
        message: 'Comment body required.',
        reason: 'comment_body_required'
      }
    }
  }
  const result = await runRest<RawIssueCommentResponse>(
    [
      '-X',
      'POST',
      ...githubBodyMediaHeaders(args.body),
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
    return {
      ok: false,
      error: {
        type: 'validation_error',
        message: 'Comment body required.',
        reason: 'comment_body_required'
      }
    }
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
