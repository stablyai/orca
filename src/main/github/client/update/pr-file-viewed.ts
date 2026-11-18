import type { GhAccountBinding } from '../../../../shared/github/accounts/account-binding'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import { acquire, release } from '../../execution/github-operation-slots'
import type { LocalGitExecOptions } from '../../repositories/github-repository-identity'
import { resolveGitHubRepoExecution } from '../../repositories/github-api-repository'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../../shared/github/repositories/repository-identity'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../api/rate-limit'
export async function setPRFileViewed(args: {
  repoPath: string
  connectionId?: string | null
  localGitOptions?: LocalGitExecOptions
  prRepo?: GitHubApiRepository | null
  pullRequestId: string
  path: string
  viewed: boolean
  expectedGhAccount?: GhAccountBinding | null
}): Promise<boolean> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    args.repoPath,
    args.prRepo,
    args.connectionId,
    args.localGitOptions,
    args.expectedGhAccount
  )
  if (!ownerRepo) {
    return false
  }
  const mutation = args.viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed'
  const query = `mutation($pullRequestId: ID!, $path: String!) {
    ${mutation}(input: { pullRequestId: $pullRequestId, path: $path }) {
      pullRequest { id }
    }
  }`
  // Per-file viewed toggles can produce high GraphQL volume; respect the budget floor.
  const guard = repositoryRateLimitGuard(ownerRepo, 'graphql', ghOptions)
  if (guard.blocked) {
    console.warn(
      `${mutation} skipped: GitHub GraphQL rate limit nearly exhausted (${guard.remaining}/${guard.limit})`
    )
    return false
  }
  await acquire()
  try {
    noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
    await ghExecFileAsync(
      [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-f',
        `pullRequestId=${args.pullRequestId}`,
        '-f',
        `path=${args.path}`
      ],
      ghOptions
    )
    return true
  } catch (err) {
    console.warn(`${mutation} failed:`, err)
    return false
  } finally {
    release()
  }
}
