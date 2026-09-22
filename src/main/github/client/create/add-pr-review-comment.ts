import type {
  GitHubCommentResult,
  GitHubPRReviewCommentInput
} from '../../../../shared/github/comment-types'
import {
  ghExecFileAsync,
  acquire,
  release,
  classifyGhError,
  type LocalGitExecOptions
} from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { mapReviewCommentResponse } from './../map/review-comment-response'
export async function addPRReviewComment(
  args: GitHubPRReviewCommentInput & {
    connectionId?: string | null
    localGitOptions?: LocalGitExecOptions
  }
): Promise<GitHubCommentResult> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    args.repoPath,
    args.prRepo,
    args.connectionId,
    args.localGitOptions
  )
  if (!ownerRepo) {
    return { ok: false, error: 'Could not resolve GitHub owner/repo for this repository' }
  }
  await acquire()
  try {
    const fields = [
      'api',
      '-X',
      'POST',
      `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${args.prNumber}/comments`,
      '--raw-field',
      `body=${args.body}`,
      '--raw-field',
      `commit_id=${args.commitId}`,
      '--raw-field',
      `path=${args.path}`,
      '--field',
      `line=${String(args.line)}`,
      '--raw-field',
      'side=RIGHT'
    ]
    if (typeof args.startLine === 'number' && args.startLine !== args.line) {
      fields.push(
        '--field',
        `start_line=${String(args.startLine)}`,
        '--raw-field',
        'start_side=RIGHT'
      )
    }
    const { stdout } = await ghExecFileAsync(fields, ghOptions)
    const data = JSON.parse(stdout) as Parameters<typeof mapReviewCommentResponse>[0]
    // Why: mapReviewCommentResponse substitutes Date.now() for a missing id, which later replies/reactions would target.
    if (typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || data.id < 1) {
      return { ok: false, error: 'Unexpected response from GitHub' }
    }
    return {
      ok: true,
      comment: mapReviewCommentResponse(data, args.body, args.path, args.line, args.startLine)
    }
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err)
    return { ok: false, error: classifyGhError(stderr).message }
  } finally {
    release()
  }
}

export async function addPRReviewCommentReply(
  repoPath: string,
  prNumber: number,
  commentId: number,
  body: string,
  threadId?: string,
  path?: string,
  line?: number,
  connectionId?: string | null,
  prRepo?: GitHubApiRepository | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubCommentResult> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    prRepo,
    connectionId,
    localGitOptions
  )
  if (!ownerRepo) {
    return { ok: false, error: 'Could not resolve GitHub owner/repo for this repository' }
  }
  await acquire()
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        '-X',
        'POST',
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${prNumber}/comments/${commentId}/replies`,
        '--raw-field',
        `body=${body}`
      ],
      ghOptions
    )
    const data = JSON.parse(stdout) as Parameters<typeof mapReviewCommentResponse>[0]
    if (typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || data.id < 1) {
      return { ok: false, error: 'Unexpected response from GitHub' }
    }
    return {
      ok: true,
      comment: mapReviewCommentResponse(data, body, path, line, undefined, threadId)
    }
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err)
    return { ok: false, error: classifyGhError(stderr).message }
  } finally {
    release()
  }
}
