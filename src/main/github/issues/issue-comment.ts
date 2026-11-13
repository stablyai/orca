import { githubBodyImageUrls, githubBodyMediaHeaders } from '../attachments/body-image-urls'
import type { GitHubCommentResult, PRComment } from '../../../shared/github/comments/comment-types'
import type { IssueSourcePreference } from '../../../shared/repo-types'
import type { LocalGitExecOptions } from '../repositories/github-repository-identity'
import type { GitHubRepositoryIdentity as OwnerRepo } from '../../../shared/github/repositories/repository-identity'
import {
  resolveGitHubRepoExecution,
  resolveIssueGitHubApiRepositorySource
} from '../repositories/github-api-repository'
import { acquire, release } from '../execution/github-operation-slots'
import { classifyGhError } from '../api/gh-error-classification'
import { ghExecFileAsync } from '../../git/command-runner/hosted-cli/gh-exec-file'
import { codeHostFailure, classifiedFailure } from '../../../shared/code-host-failure-copy'

// An explicit target keeps replies bound to the conversation; otherwise use the selected source.
export async function addIssueComment(
  repoPath: string,
  issueNumber: number,
  body: string,
  connectionId?: string | null,
  ownerRepoOverride?: OwnerRepo | null,
  localGitOptions: LocalGitExecOptions = {},
  preference?: IssueSourcePreference
): Promise<GitHubCommentResult> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    ownerRepoOverride ??
      (async () =>
        (
          await resolveIssueGitHubApiRepositorySource(
            repoPath,
            preference,
            connectionId,
            localGitOptions
          )
        ).source),
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
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${issueNumber}/comments`,
        '--input',
        '-'
      ],
      { ...ghOptions, stdin: JSON.stringify({ body }) }
    )
    const data: {
      id?: number
      node_id?: string | null
      user: { login: string; avatar_url: string; type?: string } | null
      body?: string
      body_html?: string | null
      created_at?: string
      html_url?: string
    } = JSON.parse(stdout)
    if (typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || data.id < 1) {
      return codeHostFailure('github.unexpectedResponse')
    }
    const comment: PRComment = {
      id: data.id,
      reactionSubjectId: data.node_id?.trim() || undefined,
      author: data.user?.login ?? 'You',
      authorAvatarUrl: data.user?.avatar_url ?? '',
      body: data.body ?? body,
      bodyImageUrls: githubBodyImageUrls(data.body ?? body, data.body_html),
      createdAt: data.created_at ?? new Date().toISOString(),
      url: data.html_url ?? '',
      isBot: data.user?.type === 'Bot'
    }
    return { ok: true, comment }
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err)
    return classifiedFailure(classifyGhError(stderr))
  } finally {
    release()
  }
}
