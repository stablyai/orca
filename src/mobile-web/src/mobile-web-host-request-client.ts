import {
  MOBILE_WEB_HOST_REQUEST_MAX_TIMEOUT_MS,
  MobileWebHostRequestPayloadSchema,
  MobileWebHostResultSchema,
  type MobileWebHostRequestPayload
} from '../../shared/mobile-web/host-rpc-contract'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export function requestMobileWebHost(
  requests: MobileWebOneShotRequestClient,
  method: string,
  workspaceId: string | undefined,
  params: Record<string, unknown>,
  options?: MobileWebBridgeRequestOptions
): Promise<unknown> {
  // The page and shell share the caller's deadline.
  const timeoutMs =
    options?.timeoutMs === undefined
      ? undefined
      : Math.min(Math.max(1, Math.round(options.timeoutMs)), MOBILE_WEB_HOST_REQUEST_MAX_TIMEOUT_MS)
  return requests.request(
    'workspace',
    'hostRequest',
    {
      method,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      params,
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    },
    MobileWebHostRequestPayloadSchema,
    MobileWebHostResultSchema,
    timeoutMs === undefined ? options : { ...options, timeoutMs }
  )
}

export class MobileWebHostRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  request(
    payload: MobileWebHostRequestPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<unknown> {
    return requestMobileWebHost(
      this.requests,
      payload.method,
      payload.workspaceId,
      payload.params,
      { ...options, timeoutMs: options?.timeoutMs ?? payload.timeoutMs }
    )
  }
}
