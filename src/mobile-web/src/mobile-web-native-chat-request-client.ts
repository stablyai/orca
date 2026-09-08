import { MobileWebNativeChatFileClient } from './mobile-web-native-chat-file-client'
import { mutateMobileWebHostNativeChat } from './mobile-web-host-native-chat-mutation'
import {
  subscribeMobileWebHostNativeChat,
  type MobileWebNativeChatSubscriptionArgs
} from './mobile-web-host-native-chat-subscription'
import type { MobileWebBridgeSubscriptionClient } from './mobile-web-bridge-subscription-client'
import { readMobileWebHostNativeChat } from './mobile-web-host-native-chat-read'
import {
  MobileWebNativeChatAttachImagePayloadSchema,
  MobileWebNativeChatAttachImageResultSchema,
  MobileWebNativeChatPendingReadPayloadSchema,
  MobileWebNativeChatPendingReadResultSchema,
  MobileWebNativeChatPendingWritePayloadSchema,
  MobileWebNativeChatPendingWriteResultSchema,
  MobileWebNativeChatPasteImagesPayloadSchema,
  MobileWebNativeChatPasteImagesResultSchema,
  MobileWebNativeChatReleaseImagesPayloadSchema,
  MobileWebNativeChatReleaseImagesResultSchema,
  type MobileWebNativeChatFileSearchPayload,
  type MobileWebNativeChatFileSearchResult,
  type MobileWebNativeChatAttachImagePayload,
  type MobileWebNativeChatAttachImageResult,
  type MobileWebNativeChatOpenFilePayload,
  type MobileWebNativeChatPendingReadPayload,
  type MobileWebNativeChatPendingReadResult,
  type MobileWebNativeChatPendingWritePayload,
  type MobileWebNativeChatReadPayload,
  type MobileWebNativeChatPasteImagesPayload,
  type MobileWebNativeChatPrepareCommitPayload,
  type MobileWebNativeChatReleaseImagesPayload,
  type MobileWebNativeChatRespondPayload,
  type MobileWebNativeChatSendMessagePayload,
  type MobileWebNativeChatSendResult,
  type MobileWebNativeChatStopPayload
} from '../../shared/mobile-web/native-chat-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'

export class MobileWebNativeChatRequestClient {
  private readonly files: MobileWebNativeChatFileClient
  constructor(
    private readonly requests: MobileWebOneShotRequestClient,
    private readonly subscriptions: MobileWebBridgeSubscriptionClient
  ) {
    this.files = new MobileWebNativeChatFileClient(requests)
  }

  subscribeForTab(tabId: string, ...args: MobileWebNativeChatSubscriptionArgs) {
    return subscribeMobileWebHostNativeChat(this.subscriptions, tabId, ...args)
  }

  readForTab(payload: MobileWebNativeChatReadPayload, tabId: string) {
    return readMobileWebHostNativeChat(this.requests, { ...payload, tabId })
  }

  sendMessage(
    payload: MobileWebNativeChatSendMessagePayload,
    options?: MobileWebBridgeRequestOptions,
    tabId?: string
  ): Promise<MobileWebNativeChatSendResult> {
    if (!tabId) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return mutateMobileWebHostNativeChat(this.requests, 'sendMessage', payload, tabId, options)
  }

  prepareCommit(
    payload: MobileWebNativeChatPrepareCommitPayload,
    options?: MobileWebBridgeRequestOptions,
    tabId?: string
  ): Promise<{ prepared: boolean }> {
    if (!tabId) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return mutateMobileWebHostNativeChat(this.requests, 'prepareCommit', payload, tabId, options)
  }

  respond(
    payload: MobileWebNativeChatRespondPayload,
    options?: MobileWebBridgeRequestOptions,
    tabId?: string
  ): Promise<MobileWebNativeChatSendResult> {
    if (!tabId) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return mutateMobileWebHostNativeChat(this.requests, 'respond', payload, tabId, options)
  }

  stop(
    payload: MobileWebNativeChatStopPayload,
    options?: MobileWebBridgeRequestOptions,
    tabId?: string
  ): Promise<MobileWebNativeChatSendResult> {
    if (!tabId) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return mutateMobileWebHostNativeChat(this.requests, 'stop', payload, tabId, options)
  }

  attachImage(
    payload: MobileWebNativeChatAttachImagePayload
  ): Promise<MobileWebNativeChatAttachImageResult> {
    return this.requests.request(
      'nativeChat',
      'attachImage',
      payload,
      MobileWebNativeChatAttachImagePayloadSchema,
      MobileWebNativeChatAttachImageResultSchema
    )
  }

  pasteImages(
    payload: MobileWebNativeChatPasteImagesPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<{ pasted: boolean }> {
    return this.requests.request(
      'nativeChat',
      'pasteImages',
      payload,
      MobileWebNativeChatPasteImagesPayloadSchema,
      MobileWebNativeChatPasteImagesResultSchema,
      options
    )
  }

  releaseImages(payload: MobileWebNativeChatReleaseImagesPayload): Promise<null> {
    return this.requests.request(
      'nativeChat',
      'releaseImages',
      payload,
      MobileWebNativeChatReleaseImagesPayloadSchema,
      MobileWebNativeChatReleaseImagesResultSchema
    )
  }

  pendingRead(
    payload: MobileWebNativeChatPendingReadPayload
  ): Promise<MobileWebNativeChatPendingReadResult> {
    return this.requests.request(
      'nativeChat',
      'pendingRead',
      payload,
      MobileWebNativeChatPendingReadPayloadSchema,
      MobileWebNativeChatPendingReadResultSchema
    )
  }

  pendingWrite(payload: MobileWebNativeChatPendingWritePayload): Promise<null> {
    return this.requests.request(
      'nativeChat',
      'pendingWrite',
      payload,
      MobileWebNativeChatPendingWritePayloadSchema,
      MobileWebNativeChatPendingWriteResultSchema
    )
  }

  fileSearch(
    payload: MobileWebNativeChatFileSearchPayload,
    tabId?: string
  ): Promise<MobileWebNativeChatFileSearchResult> {
    return this.files.fileSearch(payload, tabId)
  }

  openFile(payload: MobileWebNativeChatOpenFilePayload, tabId?: string): Promise<null> {
    return this.files.openFile(payload, tabId)
  }
}
