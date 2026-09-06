import type { RepoSlug } from '../../../src/shared/new-workspace/github-links'
import type { GitHubWorkItem } from '../../../src/shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../src/shared/gitlab-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import { resolveComposerMrBase, resolveComposerPrBase } from '../tasks/composer-source-base-resolve'
import {
  searchBranches,
  searchGitHubItems,
  searchGitLabItems,
  searchLinearIssues
} from '../tasks/smart-source-search-requests'
import type { HostWorkspaceCreationOperations } from './host-workspace-creation-operations'

type SourceOperations = Pick<
  HostWorkspaceCreationOperations,
  | 'searchGitHubItems'
  | 'searchGitLabItems'
  | 'searchLinearIssues'
  | 'searchBranches'
  | 'resolveGitHubRepoSlug'
  | 'lookupGitHubItem'
  | 'lookupGitHubItemByOwnerRepo'
  | 'lookupGitLabItemByPath'
  | 'resolvePrBase'
  | 'resolveMrBase'
>

export function nativeHostWorkspaceCreationSourceOperations(client: RpcClient): SourceOperations {
  return {
    searchGitHubItems: (repoId, query) => searchGitHubItems(client, repoId, query),
    searchGitLabItems: (repoId, query, state) => searchGitLabItems(client, repoId, query, state),
    searchLinearIssues: (query, linearWorkspaceId) =>
      searchLinearIssues(client, query, linearWorkspaceId),
    searchBranches: (repoId, query) => searchBranches(client, repoId, query),
    async resolveGitHubRepoSlug(repoId) {
      const response = await client.sendRequest('github.repoSlug', { repo: `id:${repoId}` })
      if (!response.ok && response.error.code === 'method_not_found') {
        return { supported: false, slug: null }
      }
      return {
        supported: true,
        slug: response.ok ? ((response as RpcSuccess).result as RepoSlug | null) : null
      }
    },
    async lookupGitHubItem(repoId, number) {
      const response = await client.sendRequest('github.workItem', {
        repo: `id:${repoId}`,
        number
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      const item = (response as RpcSuccess).result as GitHubWorkItem | null
      return item ? { ...item, repoId } : null
    },
    async lookupGitHubItemByOwnerRepo({ repoId, slug, number, type }) {
      const response = await client.sendRequest('github.workItemByOwnerRepo', {
        repo: `id:${repoId}`,
        owner: slug.owner,
        ownerRepo: slug.repo,
        ...(slug.host ? { host: slug.host } : {}),
        number,
        type
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      const item = (response as RpcSuccess).result as GitHubWorkItem | null
      return item ? { ...item, repoId } : null
    },
    async lookupGitLabItemByPath({ repoId, host, path, iid, type }) {
      const response = await client.sendRequest('gitlab.workItemByPath', {
        repo: `id:${repoId}`,
        host,
        path,
        iid,
        type
      })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      const item = (response as RpcSuccess).result as GitLabWorkItem | null
      return item ? { ...item, repoId } : null
    },
    resolvePrBase: (args) => resolveComposerPrBase({ client, ...args }),
    resolveMrBase: (args) => resolveComposerMrBase({ client, ...args })
  }
}
