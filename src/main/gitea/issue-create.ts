import type { IssueSourcePreference } from '../../shared/repo-types'
import {
  giteaCommentResult,
  parseGiteaJson,
  postGiteaHttpJson,
  type GiteaCommentResult
} from './pull-request-review-comment-shape'
import {
  directGiteaApiToken,
  encodedGiteaRepoPath,
  giteaAuthRequiredResult,
  giteaPullIndexArg,
  giteaWriteUsesTea,
  resolveGiteaMutationRepo,
  runGiteaTeaCommand,
  type GiteaProjectRef
} from './pull-request-mutation-transport'
import { teaRepoArgs, type LocalGitExecOptions } from './repository-ref'

const UNRESOLVED_REPO = 'No Gitea repository found for this repository.'
const UNEXPECTED_ISSUE = 'Gitea did not return the created issue.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

function createdIssue(data: unknown): { number: number; url: string } | null {
  if (!isRecord(data)) {
    return null
  }
  const number = positiveInteger(data.index) ?? positiveInteger(data.number)
  const urlValue = typeof data.url === 'string' ? data.url : data.html_url
  const url = typeof urlValue === 'string' ? urlValue.trim() : ''
  if (number === null || url.length === 0) {
    return null
  }
  return { number, url }
}

function canWrite(loginName: string | null | undefined): boolean {
  return directGiteaApiToken() !== null || Boolean(loginName)
}

export async function createGiteaIssue(
  repoPath: string,
  title: string,
  body: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }> {
  const trimmedTitle = title.trim()
  if (!trimmedTitle) {
    return { ok: false, error: 'Title is required' }
  }
  const repo = await resolveGiteaMutationRepo(
    repoPath,
    preference,
    connectionId ?? null,
    null,
    localGitOptions
  )
  if (!repo) {
    return { ok: false, error: UNRESOLVED_REPO }
  }
  if (!canWrite(repo.loginName)) {
    return giteaAuthRequiredResult()
  }
  const path = `/repos/${encodedGiteaRepoPath(repo)}/issues`
  if (giteaWriteUsesTea(repo)) {
    const created = await runGiteaTeaCommand(
      [
        'issues',
        'create',
        ...teaRepoArgs(repo),
        '--title',
        trimmedTitle,
        '--description',
        body,
        '-o',
        'json'
      ],
      localGitOptions,
      repoPath
    )
    if (!created.ok) {
      return created
    }
    const parsed = createdIssue(parseGiteaJson(created.stdout))
    return parsed ? { ok: true, ...parsed } : { ok: false, error: UNEXPECTED_ISSUE }
  }
  const posted = await postGiteaHttpJson(repo, path, { title: trimmedTitle, body })
  if (!posted.ok) {
    return posted
  }
  const parsed = createdIssue(posted.data)
  return parsed ? { ok: true, ...parsed } : { ok: false, error: UNEXPECTED_ISSUE }
}

export async function addGiteaIssueComment(
  repoPath: string,
  issueNumber: number,
  body: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  projectRefOverride?: GiteaProjectRef | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaCommentResult> {
  const indexArg = giteaPullIndexArg(issueNumber)
  if (!indexArg) {
    return { ok: false, error: 'Issue index must be a positive integer.' }
  }
  const repo = await resolveGiteaMutationRepo(
    repoPath,
    preference,
    connectionId ?? null,
    projectRefOverride,
    localGitOptions
  )
  if (!repo) {
    return { ok: false, error: UNRESOLVED_REPO }
  }
  if (!canWrite(repo.loginName)) {
    return giteaAuthRequiredResult()
  }
  const path = `/repos/${encodedGiteaRepoPath(repo)}/issues/${indexArg}/comments`
  if (giteaWriteUsesTea(repo)) {
    const posted = await runGiteaTeaCommand(
      ['api', '-X', 'POST', path, '-f', `body=${body}`, ...teaRepoArgs(repo)],
      localGitOptions,
      repoPath
    )
    if (!posted.ok) {
      return posted
    }
    return giteaCommentResult(parseGiteaJson(posted.stdout), body)
  }
  const posted = await postGiteaHttpJson(repo, path, { body })
  if (!posted.ok) {
    return posted
  }
  return giteaCommentResult(posted.data, body)
}
