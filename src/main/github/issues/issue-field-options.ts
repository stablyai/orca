import type { GhAccountBinding } from '../../../shared/github/accounts/account-binding'
import type { GitHubAssignableUser } from '../../../shared/github/pull-requests/pull-request-types'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../shared/github/repositories/repository-identity'
import type { IssueSourcePreference } from '../../../shared/repo-types'
import type { LocalGitExecOptions } from '../repositories/github-repository-identity'
import {
  resolveGitHubRepoExecution,
  resolveIssueGitHubApiRepositorySource
} from '../repositories/github-api-repository'
import { acquire, release } from '../execution/github-operation-slots'
import { ghExecFileAsync } from '../../git/command-runner/hosted-cli/gh-exec-file'

export async function listLabels(
  repoPath: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  repositoryOverride?: GitHubOwnerRepo | null,
  expectedGhAccount?: GhAccountBinding | null
): Promise<string[]> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    repositoryOverride ??
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
    localGitOptions,
    expectedGhAccount
  )
  if (!ownerRepo) {
    return []
  }
  await acquire()
  try {
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        '--paginate',
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/labels`,
        '--jq',
        '.[].name'
      ],
      ghOptions
    )
    return stdout
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
  } catch {
    return []
  } finally {
    release()
  }
}

export async function listAssignableUsers(
  repoPath: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  repositoryOverride?: GitHubOwnerRepo | null,
  expectedGhAccount?: GhAccountBinding | null
): Promise<GitHubAssignableUser[]> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    repositoryOverride ??
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
    localGitOptions,
    expectedGhAccount
  )
  if (!ownerRepo) {
    return []
  }
  await acquire()
  try {
    // REST pagination covers all assignees; jq emits NDJSON instead of concatenated page arrays.
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        '--paginate',
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/assignees?per_page=100`,
        '--jq',
        '.[] | {login, avatar_url}'
      ],
      ghOptions
    )
    type RESTAssignee = { login?: string; avatar_url?: string | null }
    const users: GitHubAssignableUser[] = []
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }
      try {
        const user = JSON.parse(trimmed) as RESTAssignee
        if (user.login) {
          users.push({
            login: user.login,
            name: null,
            avatarUrl: user.avatar_url ?? ''
          })
        }
      } catch {
        // Skip malformed NDJSON lines defensively.
      }
    }
    return users
  } catch {
    return []
  } finally {
    release()
  }
}
