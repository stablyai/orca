import { checkBoardsProxyRequest } from '../../shared/azure-devops/boards-proxy-path-policy'
import {
  azureDevOpsTokenConfigured,
  getAzureDevOpsAuthConfig,
  normalizeAzureDevOpsApiBaseUrl,
  requestAzureDevOpsResponseAtBase
} from './azure-devops-api-request'

/**
 * Host-side Azure Boards proxy. A plugin names a method, a path and a body;
 * the host chooses the origin, injects the credential, enforces the path
 * policy, and returns only the response status and body. The credential
 * never reaches the returned value.
 */

export type BoardsProxyRequest = {
  method: string
  path: string
  query?: Record<string, string>
  body?: unknown
}

export type BoardsProxyResponse = {
  status: number
  body: unknown
}

export async function executeBoardsProxyRequest(
  request: BoardsProxyRequest
): Promise<BoardsProxyResponse> {
  const rejection = checkBoardsProxyRequest(request)
  if (rejection) {
    return {
      status: rejection.code === 'forbidden' ? 403 : 400,
      body: { message: rejection.message }
    }
  }

  const config = getAzureDevOpsAuthConfig()
  if (!config.apiBaseUrl) {
    return {
      status: 412,
      body: { message: 'Azure DevOps is not configured for this execution host' }
    }
  }
  if (!azureDevOpsTokenConfigured(config)) {
    return {
      status: 412,
      body: {
        message: 'Azure DevOps is not configured for this execution host: no credentials are set'
      }
    }
  }

  const normalized = normalizeAzureDevOpsApiBaseUrl(config.apiBaseUrl)
  let scheme: string
  try {
    scheme = new URL(normalized).protocol
  } catch {
    scheme = ''
  }
  if (scheme !== 'https:' && scheme !== 'http:') {
    return {
      status: 412,
      body: {
        message: 'Azure DevOps is not configured for this execution host: the base URL is invalid'
      }
    }
  }

  try {
    return await requestAzureDevOpsResponseAtBase(normalized, request.path, {
      ...(request.query ? { searchParams: request.query } : {}),
      ...(request.method === 'POST' || request.method === 'PATCH'
        ? { method: request.method }
        : {}),
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.method === 'PATCH' ? { contentType: 'application/json-patch+json' } : {})
    })
  } catch {
    // requestAzureDevOpsResponseAtBase has no try/catch of its own, so a
    // rejection here comes from the fetch call (network failure, timeout,
    // abort); an HTTP error status resolves normally instead of throwing.
    return {
      status: 503,
      body: { message: 'Azure DevOps request failed' }
    }
  }
}
