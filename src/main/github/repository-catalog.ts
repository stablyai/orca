import type { GitHubRepositoryCatalogItem } from '../../shared/github-repository-catalog'
import { ghExecFileAsync } from '../git/runner'

type GitHubApiRepository = {
  full_name?: unknown
  description?: unknown
  private?: unknown
  updated_at?: unknown
  clone_url?: unknown
  ssh_url?: unknown
}

const REPOSITORY_CATALOG_LIMIT = 100

export async function listAuthenticatedGitHubRepositories(): Promise<
  GitHubRepositoryCatalogItem[]
> {
  const { stdout } = await ghExecFileAsync([
    'api',
    `user/repos?per_page=${REPOSITORY_CATALOG_LIMIT}&sort=updated&affiliation=owner,collaborator,organization_member`
  ])
  const parsed: unknown = JSON.parse(stdout)
  if (!Array.isArray(parsed)) {
    throw new Error('GitHub returned an invalid repository list')
  }

  return parsed.flatMap((value): GitHubRepositoryCatalogItem[] => {
    if (!value || typeof value !== 'object') {
      return []
    }
    const repository = value as GitHubApiRepository
    if (
      typeof repository.full_name !== 'string' ||
      typeof repository.clone_url !== 'string' ||
      typeof repository.ssh_url !== 'string'
    ) {
      return []
    }
    return [
      {
        nameWithOwner: repository.full_name,
        description: typeof repository.description === 'string' ? repository.description : null,
        isPrivate: repository.private === true,
        updatedAt: typeof repository.updated_at === 'string' ? repository.updated_at : '',
        httpsUrl: repository.clone_url,
        sshUrl: repository.ssh_url
      }
    ]
  })
}
