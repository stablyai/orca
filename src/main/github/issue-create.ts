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
    const createArgs = (issueBody: string) => {
      const args = [
        'api',
        '-X',
        'POST',
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues`,
        '--raw-field',
        `title=${trimmedTitle}`,
        '--raw-field',
        `body=${issueBody}`
      ]
      for (const label of fields?.labels ?? []) {
        args.push('--raw-field', `labels[]=${label}`)
      }
      for (const assignee of fields?.assignees ?? []) {
        args.push('--raw-field', `assignees[]=${assignee}`)
      }
      return args
    }

    const parseIssue = (stdout: string) =>
      JSON.parse(stdout) as { number?: number; html_url?: string; url?: string }

    let data: { number?: number; html_url?: string; url?: string }
    try {
      const { stdout } = await ghExecFileAsync(createArgs(body), ghOptions)
      data = parseIssue(stdout)
    } catch (err) {
      const message = githubIssueErrorMessage(err)
      if (!/body is too long \(maximum is \d+ characters\)/i.test(message)) {
        return { ok: false, error: message }
      }

      // GitHub can accept a body on update that it rejects during creation; establish the issue first.
      const { stdout } = await ghExecFileAsync(createArgs(''), ghOptions)
      data = parseIssue(stdout)
      if (typeof data.number !== 'number') {
        return { ok: false, error: 'Unexpected response from GitHub' }
      }

      try {
        await ghExecFileAsync(
          [
            'api',
            '-X',
            'PATCH',
            `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${data.number}`,
            '--raw-field',
            `body=${body}`
          ],
          ghOptions
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
