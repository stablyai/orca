import {
  getConfiguredAzureDevOpsApiBaseUrl,
  assertAzureDevOpsCliEndpoint,
  AzureDevOpsHttpError,
  normalizeAzureDevOpsApiBaseUrl,
  requestAzureDevOpsJsonAtBase
} from './azure-devops-api-request'
import {
  azureDevOpsEnvironmentTokenConfigured,
  getAzureDevOpsAuthMethod,
  resolveAzureDevOpsCredentials
} from './azure-devops-credentials'
import { AzureDevOpsAuthError } from './azure-cli-access-token'
import type { AzureDevOpsAuthStatus } from '../../shared/source-control/azure-devops-auth-types'

type AzureDevOpsConnection = {
  authenticatedUser?: {
    providerDisplayName?: string | null
    customDisplayName?: string | null
    uniqueName?: string | null
  } | null
}

function connectionAccount(connection: AzureDevOpsConnection | null): string | null {
  const user = connection?.authenticatedUser
  return user?.providerDisplayName ?? user?.customDisplayName ?? user?.uniqueName ?? null
}

export async function getAzureDevOpsAuthStatus(): Promise<AzureDevOpsAuthStatus> {
  const configured = getConfiguredAzureDevOpsApiBaseUrl()
  const baseUrl = configured ? normalizeAzureDevOpsApiBaseUrl(configured) : null
  const hasToken = azureDevOpsEnvironmentTokenConfigured()
  if (getAzureDevOpsAuthMethod() === 'azure-cli') {
    let status: AzureDevOpsAuthStatus = {
      authMethod: 'azure-cli',
      configured: true,
      authenticated: false,
      account: null,
      baseUrl,
      tokenConfigured: hasToken,
      credentialAvailable: false
    }
    try {
      if (baseUrl) {
        assertAzureDevOpsCliEndpoint(baseUrl)
      }
      const credentials = await resolveAzureDevOpsCredentials()
      if (credentials.method !== 'azure-cli') {
        throw new AzureDevOpsAuthError('token-acquisition-failed')
      }
      status = { ...status, credentialAvailable: true, credentialState: 'credential-ready' }
      if (!baseUrl) {
        return status
      }
      const connection = await requestAzureDevOpsJsonAtBase<AzureDevOpsConnection>(
        baseUrl,
        '/_apis/connectionData',
        { timeoutMs: 4000 },
        true,
        credentials
      )
      if (connection?.authenticatedUser) {
        return {
          ...status,
          authenticated: true,
          credentialState: 'authenticated',
          account: connectionAccount(connection)
        }
      }
      return status
    } catch (error) {
      const errorCode =
        error instanceof AzureDevOpsAuthError
          ? error.code
          : error instanceof AzureDevOpsHttpError && error.status === 401
            ? 'unauthorized'
            : error instanceof AzureDevOpsHttpError && error.status === 403
              ? 'forbidden'
              : 'network-error'
      return { ...status, credentialState: 'error', errorCode }
    }
  }
  if (!baseUrl && !hasToken) {
    return {
      authMethod: 'environment',
      credentialState: 'not-configured',
      credentialAvailable: false,
      configured: false,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: false
    }
  }
  if (!baseUrl) {
    return {
      authMethod: 'environment',
      credentialState: 'credential-ready',
      credentialAvailable: hasToken,
      configured: true,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: hasToken
    }
  }

  const connection = await requestAzureDevOpsJsonAtBase<AzureDevOpsConnection>(
    baseUrl,
    '/_apis/connectionData',
    { timeoutMs: 4000 }
  )
  return {
    authMethod: 'environment',
    credentialAvailable: hasToken,
    configured: hasToken || connection !== null,
    authenticated: connection !== null && (hasToken || connection.authenticatedUser !== null),
    account: connectionAccount(connection),
    baseUrl,
    tokenConfigured: hasToken
  }
}
