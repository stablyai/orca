import { checkBoardsProxyRequest } from '../../shared/azure-devops/boards-proxy-path-policy'
import {
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

  const configured = getAzureDevOpsAuthConfig().apiBaseUrl
  if (!configured) {
    return {
      status: 412,
      body: { message: 'Azure DevOps is not configured for this execution host' }
    }
  }

  try {
    // requestAzureDevOpsJsonAtBase collapses every failure to null or a generic
    // Error; that would make 401/404/429 indistinguishable to the plugin.
    return await requestAzureDevOpsResponseAtBase(
      normalizeAzureDevOpsApiBaseUrl(configured),
      request.path,
      {
        ...(request.query ? { searchParams: request.query } : {}),
        ...(request.method === 'GET'
          ? {}
          : // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: checkBoardsProxyRequest above already narrowed method to GET/POST/PATCH, and this branch excludes GET.
            { method: request.method as 'POST' | 'PATCH' }),
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(request.method === 'PATCH' ? { contentType: 'application/json-patch+json' } : {})
      }
    )
  } catch (error) {
    // requestAzureDevOpsResponseAtBase has no try/catch of its own: only a
    // transport failure (network down, timeout) reaches here, never an HTTP
    // error status, so this is never mistaken for an empty result.
    return {
      status: 503,
      body: { message: error instanceof Error ? error.message : String(error) }
    }
  }
}
