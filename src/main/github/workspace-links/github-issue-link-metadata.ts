import type { IssueInfo } from '../../../shared/github/pull-requests/pull-request-types'
import type { GitHubRepositoryIdentity } from '../../../shared/github/repositories/repository-identity'
import { ghExecFileAsync } from '../../git/command-runner/hosted-cli/gh-exec-file'
import { acquire, release } from '../execution/github-operation-slots'
import {
  getIssueGitHubApiRepository,
  resolveGitHubRepoExecution
} from '../repositories/github-api-repository'
import { githubHostExecOptions } from '../repositories/github-repository-host'
import {
  ghRepoExecOptions,
  githubRepoContext,
  withGitHubRepoExecution,
  type LocalGitExecOptions
} from '../repositories/github-repository-identity'
import { resolveGitHubWorkItemLinkRepository } from '../repositories/github-work-item-link-repository'

const ISSUE_LINK_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) { number title url }
  }
}`

type IssueLinkMetadata = Pick<IssueInfo, 'number' | 'title' | 'url'>
type IssueLinkQueryResponse = {
  data?: { repository?: { issue: IssueLinkMetadata | null } | null }
  errors?: unknown[]
}

export async function getGitHubIssueLinkMetadata(
  repoPath: string,
  number: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  repository?: GitHubRepositoryIdentity
): Promise<IssueLinkMetadata | null> {
  return withGitHubRepoExecution(repoPath, connectionId, localGitOptions, async () => {
    const { ownerRepo, ghOptions } = repository
      ? {
          ownerRepo: await resolveGitHubWorkItemLinkRepository(
            repoPath,
            repository,
            { allowSameHost: true },
            connectionId,
            localGitOptions
          ),
          ghOptions: ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
        }
      : await resolveGitHubRepoExecution(
          repoPath,
          () => getIssueGitHubApiRepository(repoPath, connectionId, localGitOptions),
          connectionId,
          localGitOptions
        )
    if (!ownerRepo && (repository || connectionId)) {
      return null
    }

    await acquire()
    try {
      if (ownerRepo) {
        const { stdout } = await ghExecFileAsync(
          [
            'api',
            'graphql',
            ...(!repository ? ['--cache', '300s'] : []),
            '-f',
            `query=${ISSUE_LINK_QUERY}`,
            '-f',
            `owner=${ownerRepo.owner}`,
            '-f',
            `repo=${ownerRepo.repo}`,
            '-F',
            `number=${number}`
          ],
          { ...ghOptions, ...githubHostExecOptions(ownerRepo) }
        )
        const result: IssueLinkQueryResponse = JSON.parse(stdout)
        const issue = result.data?.repository?.issue
        return !result.errors?.length && issue?.number === number ? issue : null
      }

      const { stdout } = await ghExecFileAsync(
        ['issue', 'view', String(number), '--json', 'number,title,url'],
        ghOptions
      )
      const issue: IssueLinkMetadata = JSON.parse(stdout)
      return issue.number === number && !/\/pull\/\d+$/.test(issue.url) ? issue : null
    } catch {
      return null
    } finally {
      release()
    }
  })
}
