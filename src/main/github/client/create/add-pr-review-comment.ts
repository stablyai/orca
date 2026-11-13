import { githubBodyMediaHeaders } from '../../attachments/body-image-urls'
import type {
  GitHubCommentResult,
  GitHubPRReviewCommentInput
} from '../../../../shared/github/comments/comment-types'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import { acquire, release } from '../../execution/github-operation-slots'
import { classifyGhError } from '../../api/gh-error-classification'
import type { LocalGitExecOptions } from '../../repositories/github-repository-identity'
import { resolveGitHubRepoExecution } from '../../repositories/github-api-repository'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../../shared/github/repositories/repository-identity'
import { mapReviewCommentResponse } from './../map/review-comment-response'
import { codeHostFailure, classifiedFailure } from '../../../../shared/code-host-failure-copy'
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
    return codeHostFailure('github.repoUnresolved')
  }
  await acquire()
  try {
    const fields = [
      'api',
      ...githubBodyMediaHeaders(args.body),
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
    // Reject synthetic fallback IDs that replies and reactions could otherwise target.
    if (typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || data.id < 1) {
      return codeHostFailure('github.unexpectedResponse')
    }
    return {
      ok: true,
      comment: mapReviewCommentResponse(data, args.body, args.path, args.line, args.startLine)
    }
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err)
    return classifiedFailure(classifyGhError(stderr))
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
    return codeHostFailure('github.repoUnresolved')
  }
  await acquire()
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        ...githubBodyMediaHeaders(body),
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
      return codeHostFailure('github.unexpectedResponse')
    }
    return {
      ok: true,
      comment: mapReviewCommentResponse(data, body, path, line, undefined, threadId)
    }
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err)
    return classifiedFailure(classifyGhError(stderr))
  } finally {
    release()
  }
}
