import type { ClassifiedError } from '../../shared/classified-error'
import type { IssueInfo } from '../../shared/github/pull-request-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import { mapIssueInfo } from './mappers'
import type { LocalGitExecOptions } from './gh-utils'
import {
  getIssueGitHubApiRepository,
  resolveGitHubRepoExecution,
  resolveIssueGitHubApiRepositorySource
} from './github-api-repository'
// prettier-ignore
import { ghExecFileAsync, acquire, release, classifyListIssuesError } from './gh-utils'

// Keep successful-empty and failed listings distinguishable; fallback toasts belong to the Tasks envelope.
export type IssueListResult = {
  items: IssueInfo[]
  error?: ClassifiedError
}

/** Linked issue numbers keep heuristic source resolution; changing list preference must not retarget existing links. */
export async function getIssue(
  repoPath: string,
  issueNumber: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<IssueInfo | null> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    () => getIssueGitHubApiRepository(repoPath, connectionId, localGitOptions),
    connectionId,
    localGitOptions
  )
  // Without local cwd, unresolved connection-backed requests could target gh's default repository.
  if (connectionId && !ownerRepo) {
    return null
  }
  await acquire()
  try {
    if (ownerRepo) {
      const { stdout } = await ghExecFileAsync(
        [
          'api',
          '--cache',
          '300s',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${issueNumber}`
        ],
        ghOptions
      )
      const data = JSON.parse(stdout)
      return mapIssueInfo(data)
    }
    // Local compatibility path relies on gh repository discovery.
    const { stdout } = await ghExecFileAsync(
      ['issue', 'view', String(issueNumber), '--json', 'number,title,state,url,labels,body'],
      ghOptions
    )
    const data = JSON.parse(stdout)
    return mapIssueInfo(data)
  } catch {
    return null
  } finally {
    release()
  }
}

/** Return classified failures separately so unavailable repositories cannot look like empty backlogs. */
export async function listIssues(
  repoPath: string,
  limit = 20,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<IssueListResult> {
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
  // Refuse unresolved remote identities rather than listing gh's default repository.
  if (connectionId && !ownerRepo) {
    return {
      items: [],
      error: {
        type: 'not_found',
        message: 'Could not resolve GitHub owner/repo for this repository'
      }
    }
  }
  await acquire()
  try {
    if (ownerRepo) {
      const { stdout } = await ghExecFileAsync(
        [
          'api',
          '--cache',
          '120s',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues?per_page=${limit}&state=open&sort=updated&direction=desc`
        ],
        ghOptions
      )
      const data = JSON.parse(stdout) as Record<string, unknown>[]
      // GitHub REST issues includes PRs; exclude them from this issue-only result.
      return {
        items: data
          .filter((d) => !('pull_request' in d))
          .map((d) => mapIssueInfo(d as Parameters<typeof mapIssueInfo>[0]))
      }
    }
    // Local compatibility path relies on gh repository discovery.
    const { stdout } = await ghExecFileAsync(
      ['issue', 'list', '--json', 'number,title,state,url,labels', '--limit', String(limit)],
      ghOptions
    )
    const data = JSON.parse(stdout) as unknown[]
    return {
      items: data.map((d) => mapIssueInfo(d as Parameters<typeof mapIssueInfo>[0]))
    }
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err)
    return {
      items: [],
      error: classifyListIssuesError(stderr)
    }
  } finally {
    release()
  }
}
