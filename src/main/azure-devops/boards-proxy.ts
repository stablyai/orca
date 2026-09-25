import {
  BOARDS_PROXY_JSON_PATCH_CONTENT_TYPE,
  checkBoardsProxyRequest
} from '../../shared/azure-devops/boards-proxy-path-policy'
import { classifyBoardsProxyStatus } from '../../shared/azure-devops/boards-proxy-status-classification'
import type { PluginTaskSourceErrorCode } from '../../shared/plugins/plugin-task-source-contract'
import {
  azureDevOpsTokenConfigured,
  getAzureDevOpsAuthConfig,
  requestAzureDevOpsResponseAtBase
} from './azure-devops-api-request'
import { resolveAzureDevOpsApiBaseUrl } from './azure-devops-organization-base-urls'

/**
 * Host-side Azure Boards proxy. A plugin names a method, a path and a body;
 * the host chooses the origin, injects the credential, enforces the path
 * policy, and returns only the response status and body. The credential
 * never reaches the returned value.
 */

export type BoardsProxyRequest = {
  method: string
  path: string
  /** Selects one of the configured organizations; absent means the first. */
  organization?: string
  query?: Record<string, string>
  body?: unknown
  /** Creating a work item is a POST whose body is a JSON Patch document, so
   *  the method alone does not determine the media type. The JSON Patch type
   *  is the only one a caller may ask for. */
  contentType?: typeof BOARDS_PROXY_JSON_PATCH_CONTENT_TYPE
}

export type BoardsProxyResponse = {
  status: number
  body: unknown
  /** Host classification of `status`; null on success. */
  code: PluginTaskSourceErrorCode | null
}

export async function executeBoardsProxyRequest(
  request: BoardsProxyRequest
): Promise<BoardsProxyResponse> {
  const response = await resolveBoardsProxyResponse(request)
  return { ...response, code: classifyBoardsProxyStatus(response.status) }
}

async function resolveBoardsProxyResponse(
  request: BoardsProxyRequest
): Promise<Omit<BoardsProxyResponse, 'code'>> {
  const rejection = checkBoardsProxyRequest(request)
  if (rejection) {
    return {
      status: rejection.code === 'forbidden' ? 403 : 400,
      body: { message: rejection.message }
    }
  }

  const resolution = resolveAzureDevOpsApiBaseUrl(request.organization)
  if (!resolution.ok) {
    return resolution.reason === 'unknown-organization'
      ? {
          status: 400,
          body: {
            message: 'Azure DevOps organization is not configured for this execution host'
          }
        }
      : {
          status: 412,
          body: { message: 'Azure DevOps is not configured for this execution host' }
        }
  }
  if (!azureDevOpsTokenConfigured(getAzureDevOpsAuthConfig())) {
    return {
      status: 412,
      body: {
        message: 'Azure DevOps is not configured for this execution host: no credentials are set'
      }
    }
  }

  let scheme: string
  try {
    scheme = new URL(resolution.baseUrl).protocol
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
    return await requestAzureDevOpsResponseAtBase(resolution.baseUrl, request.path, {
      ...(request.query ? { searchParams: request.query } : {}),
      ...(request.method === 'POST' || request.method === 'PATCH'
        ? { method: request.method }
        : {}),
      ...(request.body === undefined ? {} : { body: request.body }),
      // PATCH on this API is always a JSON Patch; POST is one only when the
      // caller says so (creating a work item), and plain JSON otherwise.
      ...(request.method === 'PATCH' ||
      request.contentType === BOARDS_PROXY_JSON_PATCH_CONTENT_TYPE
        ? { contentType: BOARDS_PROXY_JSON_PATCH_CONTENT_TYPE }
        : {})
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
