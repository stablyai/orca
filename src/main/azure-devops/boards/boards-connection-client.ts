import type { AzureBoardsConnection } from '../../../shared/azure-devops/azure-boards-agent-types'
import { getAzCliAzureDevOpsAccessToken } from '../az-cli-access-token'
import {
  azureDevOpsTokenConfigured,
  getAzureDevOpsAuthConfig,
  requestAzureDevOpsJsonAtBase
} from '../azure-devops-api-request'
import type { AzureDevOpsRepoRef } from '../repository-ref'
import { resolveAzureDevOpsApiBases } from './api-bases'

type RawConnectionData = {
  authenticatedUser?: {
    providerDisplayName?: string | null
    customDisplayName?: string | null
  } | null
}

/** Signs in against the repo's own organization, so an agent learns who it acts as before it reads. */
export async function getAzureBoardsConnection(
  repo: AzureDevOpsRepoRef
): Promise<AzureBoardsConnection> {
  const tokenConfigured = azureDevOpsTokenConfigured(getAzureDevOpsAuthConfig())
  const credentialSource = tokenConfigured
    ? 'token'
    : (await getAzCliAzureDevOpsAccessToken()) !== null
      ? 'azure-cli'
      : null
  const data =
    credentialSource === null
      ? null
      : await requestAzureDevOpsJsonAtBase<RawConnectionData>(
          resolveAzureDevOpsApiBases(repo).collection,
          '/_apis/connectionData',
          { timeoutMs: 5000 }
        )
  const user = data?.authenticatedUser
  return {
    authenticated: data !== null,
    account: user?.providerDisplayName ?? user?.customDisplayName ?? null,
    credentialSource,
    organization: repo.organization ?? null,
    project: repo.project,
    repository: repo.repository,
    webBaseUrl: repo.webBaseUrl
  }
}
