import { acquire, release } from '../../execution/github-operation-slots'
import { gitExecFileAsync } from '../../../git/command-runner/git-exec-file'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import { resolveGitHubRepoExecution } from '../../repositories/github-api-repository'
import { getGitHubApiRepositoryForRemote } from '../../repositories/github-api-repository-remote-probe'
import { githubRepoIdentityKey } from '../../../../shared/github/repositories/repository-identity-key'
import type { GitHubRepositoryIdentity } from '../../../../shared/github/repositories/repository-identity'
import { githubHostExecOptions } from '../../repositories/github-repository-host'

// A repository's id never changes, and survives a rename or transfer that its old name redirects.
const repositoryIds = new Map<string, number>()

/** The remote a branch pushes to and pulls from; null when it tracks none or one this process can't read. */
async function trackedRemote(
  repoPath: string,
  branch: string,
  connectionId: string | null | undefined
): Promise<string | null> {
  if (connectionId) {
    return null
  }
  const { stdout } = await gitExecFileAsync(['config', '--get', `branch.${branch}.remote`], {
    cwd: repoPath
  }).catch(() => ({ stdout: '' }))
  const remote = stdout.trim()
  return remote && remote !== '.' ? remote : null
}

/** The GitHub repository a branch tracks, else the checkout's origin: its name, and its id when
 *  GitHub answers. Null when neither remote names a GitHub repository. */
export async function getGitHubTrackedRepository(
  repoPath: string,
  branch: string,
  connectionId?: string | null
): Promise<{ id: number | null; fullName: string } | null> {
  const remote = await trackedRemote(repoPath, branch, connectionId)
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    remote ? () => getGitHubApiRepositoryForRemote(repoPath, remote, connectionId) : undefined,
    connectionId
  )
  if (!ownerRepo) {
    return null
  }
  const fullName = `${ownerRepo.owner}/${ownerRepo.repo}`
  return { id: await getGitHubRepositoryId(ownerRepo, ghOptions), fullName }
}

/** A GitHub repository's id, as this machine's gh reads it; null when GitHub doesn't answer. */
export async function getGitHubRepositoryId(
  ownerRepo: GitHubRepositoryIdentity,
  ghOptions: Parameters<typeof ghExecFileAsync>[1] = githubHostExecOptions(ownerRepo)
): Promise<number | null> {
  const key = githubRepoIdentityKey(ownerRepo)
  const known = repositoryIds.get(key)
  if (known !== undefined) {
    return known
  }
  await acquire()
  try {
    const { stdout } = await ghExecFileAsync(
      ['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}`, '--jq', '.id'],
      { ...ghOptions, timeout: 10_000 }
    )
    const id = Number(stdout.trim())
    if (!Number.isSafeInteger(id) || id <= 0) {
      return null
    }
    repositoryIds.set(key, id)
    return id
  } catch {
    return null
  } finally {
    release()
  }
}
