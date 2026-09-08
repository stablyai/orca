import {
  MOBILE_WEB_NATIVE_CHAT_FILE_RESULT_LIMIT,
  type MobileWebNativeChatFileSearchPayload,
  type MobileWebNativeChatOpenFilePayload
} from '../../shared/mobile-web/native-chat-operation-contract'
import { MobileWebRelativePathSchema } from '../../shared/mobile-web/bridge-operation-contract'
import { requestMobileWebHost } from './mobile-web-host-request-client'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

const REQUEST_TIMEOUT_MS = 15_000

export class MobileWebNativeChatFileClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  async fileSearch(
    payload: MobileWebNativeChatFileSearchPayload,
    tabId?: string
  ): Promise<{ paths: string[] }> {
    const target = this.target(payload, tabId)
    const result = await requestMobileWebHost(
      this.requests,
      'mobileWeb.nativeChat.fileSearch',
      payload.workspaceId,
      {
        ...target,
        search: { query: payload.query, limit: MOBILE_WEB_NATIVE_CHAT_FILE_RESULT_LIMIT }
      },
      { timeoutMs: REQUEST_TIMEOUT_MS }
    )
    if (!isRecord(result) || !Array.isArray(result.files)) {
      throw new MobileWebBridgeClientError('invalid_message', false)
    }
    const paths = result.files.flatMap((file): string[] => {
      const path = MobileWebRelativePathSchema.safeParse(
        isRecord(file) ? file.relativePath : undefined
      )
      return path.success ? [path.data] : []
    })
    return { paths: paths.slice(0, MOBILE_WEB_NATIVE_CHAT_FILE_RESULT_LIMIT) }
  }

  async openFile(payload: MobileWebNativeChatOpenFilePayload, tabId?: string): Promise<null> {
    const target = this.target(payload, tabId)
    const result = await requestMobileWebHost(
      this.requests,
      'mobileWeb.nativeChat.openFile',
      payload.workspaceId,
      { ...target, pathText: payload.pathText, timeoutMs: REQUEST_TIMEOUT_MS },
      { timeoutMs: REQUEST_TIMEOUT_MS }
    )
    if (!isRecord(result) || typeof result.opened !== 'boolean') {
      throw new MobileWebBridgeClientError('invalid_message', false)
    }
    return null
  }

  private target(payload: { sessionId: string }, tabId: string | undefined) {
    if (!tabId) {
      throw new MobileWebBridgeClientError('invalid_request', false)
    }
    return { tabId, sessionId: payload.sessionId }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
