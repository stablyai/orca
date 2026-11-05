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
import { codeHostFailure } from '../../shared/code-host-failure-copy'

function githubIssueErrorMessage(error: unknown): string {
  const { stderr, stdout } = extractExecError(error)
  return stderr.trim() || stdout.trim()
}

/** Explicit owner/repo preserves the Tasks-selected source independently of cwd remotes. */
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
    return codeHostFailure('titleRequired')
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
    return codeHostFailure('github.repoUnresolved')
  }
  await acquire()
  try {
    const issuesEndpoint = `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues`
    // Why: stdin keeps large inline-image bodies off argv, which Windows caps at 32K chars.
    const createIssueRequest = (issueBody: string) =>
      ghExecFileAsync(['api', '-X', 'POST', issuesEndpoint, '--input', '-'], {
        ...ghOptions,
        stdin: JSON.stringify({
          title: trimmedTitle,
          body: issueBody,
          ...(fields?.labels?.length ? { labels: fields.labels } : {}),
          ...(fields?.assignees?.length ? { assignees: fields.assignees } : {})
        })
      })

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

      // GitHub can accept a body on update that it rejects during creation; establish the issue first.
      const { stdout } = await createIssueRequest('')
      data = parseIssue(stdout)
      if (typeof data.number !== 'number') {
        return codeHostFailure('github.unexpectedResponse')
      }

      try {
        await ghExecFileAsync(
          ['api', '-X', 'PATCH', `${issuesEndpoint}/${data.number}`, '--input', '-'],
          { ...ghOptions, stdin: JSON.stringify({ body }) }
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
      return codeHostFailure('github.unexpectedResponse')
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
