import type { IssueSourcePreference } from '../../shared/repository/repo-types'
import {
  encodedGiteaRepoPath,
  giteaWriteUsesGt,
  runGiteaGtCommand,
  type GiteaProjectRef
} from './pull-request-mutation-transport'
import {
  giteaCommentResult,
  isGiteaJsonRecord,
  loadCreatedGiteaInlineComment,
  mapGiteaInlineComment,
  mapGiteaReplyUrl,
  parseGiteaJson,
  postGiteaHttpJson,
  postGiteaGtJson,
  type GiteaCommentResult
} from './pull-request-review-comment-shape'
import {
  giteaPositiveIntegerText,
  isResolvedGiteaPull,
  resolveGiteaPullTarget,
  type ResolvedGiteaPull
} from './pull-request-review-target'
import { gtRepoArgs, type LocalGitExecOptions } from './repository-ref'
import type { GiteaPRInlineCommentInput } from '../../shared/gitea-types'

export type { GiteaCommentResult, GiteaPRInlineCommentInput }

function inlineAnchorError(input: GiteaPRInlineCommentInput): string | null {
  if (!input.body.trim()) {
    return 'Comment body is required.'
  }
  if (input.replyToCommentId !== undefined) {
    return giteaPositiveIntegerText(input.replyToCommentId)
      ? null
      : 'Reply comment id must be a positive integer.'
  }
  if (!input.path.trim()) {
    return 'Inline comment path is required.'
  }
  if (!Number.isInteger(input.line) || input.line <= 0) {
    return 'Inline comment line must be a positive integer.'
  }
  if (!input.headSha.trim()) {
    return 'Inline comment commit is required.'
  }
  return null
}

export async function addGiteaPRComment(
  repoPath: string,
  index: number,
  body: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaCommentResult> {
  const trimmed = body.trim()
  if (!trimmed) {
    return { ok: false, error: 'Comment body is required.' }
  }
  const resolved = await resolveGiteaPullTarget(
    repoPath,
    index,
    preference,
    connectionId,
    projectRef,
    localGitOptions
  )
  if (!isResolvedGiteaPull(resolved)) {
    return resolved
  }
  const path = `/repos/${encodedGiteaRepoPath(resolved.repo)}/issues/${resolved.indexArg}/comments`
  if (giteaWriteUsesGt(resolved.repo)) {
    const posted = await runGiteaGtCommand(
      ['api', '-X', 'POST', path, '-f', `body=${trimmed}`, ...gtRepoArgs(resolved.repo)],
      localGitOptions,
      repoPath
    )
    if (!posted.ok) {
      return posted
    }
    return giteaCommentResult(parseGiteaJson(posted.stdout), trimmed)
  }
  const posted = await postGiteaHttpJson(resolved.repo, path, { body: trimmed })
  if (!posted.ok) {
    return posted
  }
  return giteaCommentResult(posted.data, trimmed)
}

function singleInlineReviewBody(input: GiteaPRInlineCommentInput): Record<string, unknown> {
  return {
    event: 'COMMENT',
    body: '',
    commit_id: input.headSha.trim(),
    comments: [
      {
        path: input.path.trim(),
        new_position: input.line,
        body: input.body.trim()
      }
    ]
  }
}

async function addReplyToComment(
  resolved: ResolvedGiteaPull,
  replyId: string,
  body: string,
  localGitOptions: LocalGitExecOptions,
  repoPath: string
): Promise<GiteaCommentResult> {
  const trimmed = body.trim()
  const path = `/repos/${encodedGiteaRepoPath(resolved.repo)}/pulls/comments/${replyId}`
  if (giteaWriteUsesGt(resolved.repo)) {
    const posted = await runGiteaGtCommand(
      ['api', '-X', 'POST', path, '-f', `body=${trimmed}`, ...gtRepoArgs(resolved.repo)],
      localGitOptions,
      repoPath
    )
    if (!posted.ok) {
      return posted
    }
    const parsed = parseGiteaJson(posted.stdout)
    if (isGiteaJsonRecord(parsed)) {
      const comment = mapGiteaInlineComment(parsed, { body: trimmed, path: '', line: null })
      if (comment) {
        return { ok: true, comment }
      }
    }
    const reply = mapGiteaReplyUrl(posted.stdout, trimmed)
    return reply
      ? { ok: true, comment: reply }
      : { ok: false, error: 'Gitea did not return the created reply.' }
  }
  const posted = await postGiteaHttpJson(resolved.repo, path, { body: trimmed })
  if (!posted.ok) {
    return posted
  }
  if (!isGiteaJsonRecord(posted.data)) {
    return { ok: false, error: 'Gitea did not return the created reply.' }
  }
  const comment = mapGiteaInlineComment(posted.data, { body: trimmed, path: '', line: null })
  return comment
    ? { ok: true, comment }
    : { ok: false, error: 'Gitea did not return the created reply.' }
}

export async function addGiteaPRInlineComment(
  repoPath: string,
  index: number,
  input: GiteaPRInlineCommentInput,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRef?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaCommentResult> {
  const error = inlineAnchorError(input)
  if (error) {
    return { ok: false, error }
  }
  const resolved = await resolveGiteaPullTarget(
    repoPath,
    index,
    preference,
    connectionId,
    projectRef,
    localGitOptions
  )
  if (!isResolvedGiteaPull(resolved)) {
    return resolved
  }
  if (input.replyToCommentId !== undefined) {
    return addReplyToComment(
      resolved,
      input.replyToCommentId,
      input.body,
      localGitOptions,
      repoPath
    )
  }
  const path = `/repos/${encodedGiteaRepoPath(resolved.repo)}/pulls/${resolved.indexArg}/reviews`
  const body = singleInlineReviewBody(input)
  const fallback = { body: input.body.trim(), path: input.path.trim(), line: input.line }
  if (giteaWriteUsesGt(resolved.repo)) {
    const posted = await postGiteaGtJson(resolved.repo, path, body, localGitOptions, repoPath)
    if (!posted.ok) {
      return posted
    }
    return loadCreatedGiteaInlineComment(
      resolved.repo,
      resolved.indexArg,
      parseGiteaJson(posted.stdout),
      fallback
    )
  }
  const posted = await postGiteaHttpJson(resolved.repo, path, body)
  if (!posted.ok) {
    return posted
  }
  return loadCreatedGiteaInlineComment(resolved.repo, resolved.indexArg, posted.data, fallback)
}
