import type { IssueSourcePreference } from '../../shared/repo-types'
import {
  encodedGiteaRepoPath,
  giteaAuthRequiredResult,
  giteaWriteUsesTea,
  runGiteaTeaCommand,
  teaPullCommand,
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
  postGiteaTeaJson,
  type GiteaCommentResult
} from './pull-request-review-comment-shape'
import {
  giteaPositiveIntegerText,
  isResolvedGiteaPull,
  resolveGiteaPullTarget,
  type ResolvedGiteaPull
} from './pull-request-review-target'
import { teaRepoArgs, type LocalGitExecOptions } from './repository-ref'

export type { GiteaCommentResult }

export type GiteaPRInlineCommentInput = {
  body: string
  path: string
  line: number
  headSha: string
  replyToCommentId?: string
}

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
  if (giteaWriteUsesTea(resolved.repo)) {
    const posted = await runGiteaTeaCommand(
      ['api', '-X', 'POST', path, '-f', `body=${trimmed}`, ...teaRepoArgs(resolved.repo)],
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

async function postThreadReply(
  resolved: ResolvedGiteaPull,
  commentId: string,
  body: string,
  repoPath: string,
  localGitOptions: LocalGitExecOptions
): Promise<GiteaCommentResult> {
  if (giteaWriteUsesTea(resolved.repo)) {
    const args = teaPullCommand(resolved.repo, ['reply', resolved.indexArg, commentId, body])
    if (!args) {
      return giteaAuthRequiredResult()
    }
    const posted = await runGiteaTeaCommand(args, localGitOptions, repoPath)
    if (!posted.ok) {
      return posted
    }
    const comment = mapGiteaReplyUrl(posted.stdout, body)
    return comment
      ? { ok: true, comment }
      : { ok: false, error: 'Gitea did not return the created comment.' }
  }
  const posted = await postGiteaHttpJson(
    resolved.repo,
    `/repos/${encodedGiteaRepoPath(resolved.repo)}/pulls/${resolved.indexArg}/comments/${commentId}/replies`,
    { body }
  )
  if (!posted.ok) {
    return posted
  }
  const comment = mapGiteaInlineComment(isGiteaJsonRecord(posted.data) ? posted.data : {}, {
    body,
    path: '',
    line: null
  })
  return comment
    ? { ok: true, comment }
    : { ok: false, error: 'Gitea did not return the created comment.' }
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
  const anchorError = inlineAnchorError(input)
  if (anchorError) {
    return { ok: false, error: anchorError }
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
  const trimmed = input.body.trim()
  const replyTo = input.replyToCommentId ? giteaPositiveIntegerText(input.replyToCommentId) : null
  if (replyTo) {
    return postThreadReply(resolved, replyTo, trimmed, repoPath, localGitOptions)
  }
  const reviewBody = {
    event: 'COMMENT',
    commit_id: input.headSha.trim(),
    comments: [{ path: input.path.trim(), new_position: input.line, body: trimmed }]
  }
  const path = `/repos/${encodedGiteaRepoPath(resolved.repo)}/pulls/${resolved.indexArg}/reviews`
  const posted = giteaWriteUsesTea(resolved.repo)
    ? await postGiteaTeaJson(resolved.repo, path, reviewBody, localGitOptions, repoPath)
    : await postGiteaHttpJson(resolved.repo, path, reviewBody)
  if (!posted.ok) {
    return posted
  }
  const data = 'stdout' in posted ? parseGiteaJson(posted.stdout) : posted.data
  return loadCreatedGiteaInlineComment(resolved.repo, resolved.indexArg, data, {
    body: trimmed,
    path: input.path.trim(),
    line: input.line
  })
}
