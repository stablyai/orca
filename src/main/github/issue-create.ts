import type {
  GitHubCreateIssueFields,
  GitHubCreateIssueResult
} from '../../shared/issue-mutation-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import type { LocalGitExecOptions } from './gh-utils'
import {
  resolveGitHubRepoExecution,
  resolveIssueGitHubApiRepositorySource
} from './github-api-repository'
import { acquire, extractExecError, ghExecFileAsync, release } from './gh-utils'

function githubIssueErrorMessage(error: unknown): string {
  const { stderr, stdout } = extractExecError(error)
  return stderr.trim() || stdout.trim()
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
    const createArgs = () => [
      'api',
      '-X',
      'POST',
      `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues`,
      '--input',
      '-'
    ]
    const createInput = (issueBody: string) =>
      JSON.stringify({
        title: trimmedTitle,
        body: issueBody,
        ...(fields?.labels?.length ? { labels: fields.labels } : {}),
        ...(fields?.assignees?.length ? { assignees: fields.assignees } : {})
      })
    const createIssueRequest = (issueBody: string) =>
      ghExecFileAsync(createArgs(), { ...ghOptions, stdin: createInput(issueBody) })
    const updateIssueBodyRequest = (issueNumber: number) =>
      ghExecFileAsync(
        [
          'api',
          '-X',
          'PATCH',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${issueNumber}`,
          '--input',
          '-'
        ],
        { ...ghOptions, stdin: JSON.stringify({ body }) }
      )

    const parseIssue = (stdout: string) =>
      JSON.parse(stdout) as { number?: number; html_url?: string; url?: string }

    let data: { number?: number; html_url?: string; url?: string }
    try {
      const { stdout } = await createIssueRequest(body)
      data = parseIssue(stdout)
    } catch (err) {
      const message = githubIssueErrorMessage(err)
      if (!/body is too long \(maximum is \d+ characters\)/i.test(message)) {
        return { ok: false, error: message }
      }

      // Why: GitHub rejects oversized bodies on create but accepts the same body
      // on update, so establish the issue before attaching its body.
      const { stdout } = await createIssueRequest('')
      data = parseIssue(stdout)
      if (typeof data.number !== 'number') {
        return { ok: false, error: 'Unexpected response from GitHub' }
      }

      try {
        await updateIssueBodyRequest(data.number)
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
