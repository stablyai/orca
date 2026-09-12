import type {
  GitHubCreateIssueFields,
  GitHubCreateIssueResult
} from '../../shared/issue-mutation-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import type { LocalGitExecOptions } from './gh-utils'
import { withGhApiJsonInput } from './gh-api-json-input'
import {
  resolveGitHubRepoExecution,
  resolveIssueGitHubApiRepositorySource
} from './github-api-repository'
import { acquire, extractExecError, ghExecFileAsync, release } from './gh-utils'

function githubIssueErrorMessage(error: unknown): string {
  const { stderr, stdout } = extractExecError(error)
  return stderr.trim() || stdout.trim()
}

function isRecoverableOversizedIssueBodyError(error: unknown): boolean {
  const message = githubIssueErrorMessage(error)
  if (/body is too long \(maximum is \d+ characters\)/i.test(message)) {
    return true
  }
  // Why: Windows CreateProcess rejects argv over 32767 before gh can return 422.
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
  return code === 'ENAMETOOLONG' || /ENAMETOOLONG/i.test(message)
}

/**
 * Create a new GitHub issue. Uses `gh api` with explicit owner/repo so the
 * call does not depend on the current working directory having a remote that
 * matches the repo the user picked in the tasks page.
 */
export async function createIssue(
  repoPath: string,
  title: string,
  body: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  fields?: GitHubCreateIssueFields,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubCreateIssueResult> {
  const trimmedTitle = title.trim()
  if (!trimmedTitle) {
    return { ok: false, error: 'Title is required' }
  }
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    async () =>
      (
        await resolveIssueGitHubApiRepositorySource(
          repoPath,
          preference,
          connectionId,
          localGitOptions
        )
      ).source,
    connectionId,
    localGitOptions
  )
  if (!ownerRepo) {
    return { ok: false, error: 'Could not resolve GitHub owner/repo for this repository' }
  }
  await acquire()
  try {
    const postIssue = (issueBody: string) =>
      withGhApiJsonInput(
        {
          title: trimmedTitle,
          body: issueBody,
          ...(fields?.labels?.length ? { labels: fields.labels } : {}),
          ...(fields?.assignees?.length ? { assignees: fields.assignees } : {})
        },
        (inputArgs) =>
          ghExecFileAsync(
            [
              'api',
              '-X',
              'POST',
              `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues`,
              ...inputArgs
            ],
            ghOptions
          )
      )

    const parseIssue = (stdout: string) =>
      JSON.parse(stdout) as { number?: number; html_url?: string; url?: string }

    let data: { number?: number; html_url?: string; url?: string }
    try {
      const { stdout } = await postIssue(body)
      data = parseIssue(stdout)
    } catch (err) {
      if (!isRecoverableOversizedIssueBodyError(err)) {
        return { ok: false, error: githubIssueErrorMessage(err) }
      }

      // Why: GitHub rejects oversized bodies on create but accepts the same body
      // on update, so establish the issue before attaching its body.
      const { stdout } = await postIssue('')
      data = parseIssue(stdout)
      if (typeof data.number !== 'number') {
        return { ok: false, error: 'Unexpected response from GitHub' }
      }

      try {
        await withGhApiJsonInput({ body }, (inputArgs) =>
          ghExecFileAsync(
            [
              'api',
              '-X',
              'PATCH',
              `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${data.number}`,
              ...inputArgs
            ],
            ghOptions
          )
        )
      } catch (patchErr) {
        const patchMessage = githubIssueErrorMessage(patchErr)
        const identity = data.html_url ?? data.url ?? `#${data.number}`
        return {
          ok: true,
          number: data.number,
          url: String(data.html_url ?? data.url ?? ''),
          bodySaveWarning: `Issue ${identity} was created, but saving its body failed: ${patchMessage}`
        }
      }
    }

    if (typeof data.number !== 'number') {
      return { ok: false, error: 'Unexpected response from GitHub' }
    }
    return {
      ok: true,
      number: data.number,
      url: String(data.html_url ?? data.url ?? '')
    }
  } catch (err) {
    return { ok: false, error: githubIssueErrorMessage(err) }
  } finally {
    release()
  }
}
