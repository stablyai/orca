import {
  MobileWebFileChunkPayloadSchema,
  MobileWebFileDirectoryPayloadSchema,
  MobileWebFileDirectoryResultSchema,
  type MobileWebFileChunkPayload,
  type MobileWebFileChunkResult,
  type MobileWebFileDirectoryPayload,
  type MobileWebFileDirectoryResult
} from '../../shared/mobile-web/bridge-operation-contract'
import { requestMobileWebHost } from './mobile-web-host-request-client'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { decodeMobileWebFileChunk } from './mobile-web-file-chunk'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebFileReadClient {
  constructor(protected readonly requests: MobileWebOneShotRequestClient) {}

  directory(
    payload: MobileWebFileDirectoryPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileDirectoryResult> {
    if (!MobileWebFileDirectoryPayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return this.requestHost(
      'mobileWeb.files.readDir',
      payload.workspaceId,
      { relativePath: payload.relativePath, limit: payload.limit },
      (result) => {
        const parsed = MobileWebFileDirectoryResultSchema.omit({ workspaceId: true })
          .strip()
          .safeParse(result)
        if (
          !parsed.success ||
          parsed.data.relativePath !== payload.relativePath ||
          parsed.data.entries.length > payload.limit
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return { ...parsed.data, workspaceId: payload.workspaceId }
      },
      options
    )
  }

  readChunk(
    payload: MobileWebFileChunkPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileChunkResult> {
    if (!MobileWebFileChunkPayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return this.requestHost(
      'files.readChunk',
      payload.workspaceId,
      { relativePath: payload.relativePath, offset: payload.offset, length: payload.length },
      (result) => decodeMobileWebFileChunk(result, payload),
      options
    )
  }

  protected requestHost<T>(
    method: string,
    workspaceId: string,
    params: Record<string, unknown>,
    project: (result: unknown) => T,
    options?: MobileWebBridgeRequestOptions
  ): Promise<T> {
    return requestMobileWebHost(this.requests, method, workspaceId, params, options).then(project)
  }
}
