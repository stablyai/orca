import {
  MobileWebNativeChatFileSearchPayloadSchema,
  MobileWebNativeChatFileSearchResultSchema,
  MobileWebNativeChatAttachImagePayloadSchema,
  MobileWebNativeChatAttachImageResultSchema,
  MobileWebNativeChatOpenFilePayloadSchema,
  MobileWebNativeChatOpenFileResultSchema,
  MobileWebNativeChatPendingReadPayloadSchema,
  MobileWebNativeChatPendingReadResultSchema,
  MobileWebNativeChatPendingWritePayloadSchema,
  MobileWebNativeChatPendingWriteResultSchema,
  MobileWebNativeChatReadPayloadSchema,
  MobileWebNativeChatReadResultSchema,
  MobileWebNativeChatReadabilityPayloadSchema,
  MobileWebNativeChatReadabilityResultSchema,
  MobileWebNativeChatPasteImagesPayloadSchema,
  MobileWebNativeChatPasteImagesResultSchema,
  MobileWebNativeChatPrepareCommitPayloadSchema,
  MobileWebNativeChatPrepareCommitResultSchema,
  MobileWebNativeChatReleaseImagesPayloadSchema,
  MobileWebNativeChatReleaseImagesResultSchema,
  MobileWebNativeChatRespondPayloadSchema,
  MobileWebNativeChatSendMessagePayloadSchema,
  MobileWebNativeChatSendResultSchema,
  MobileWebNativeChatStopPayloadSchema,
  type MobileWebNativeChatFileSearchPayload,
  type MobileWebNativeChatFileSearchResult,
  type MobileWebNativeChatAttachImagePayload,
  type MobileWebNativeChatAttachImageResult,
  type MobileWebNativeChatOpenFilePayload,
  type MobileWebNativeChatPendingReadPayload,
  type MobileWebNativeChatPendingReadResult,
  type MobileWebNativeChatPendingWritePayload,
  type MobileWebNativeChatReadPayload,
  type MobileWebNativeChatReadResult,
  type MobileWebNativeChatReadabilityPayload,
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
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  read(payload: MobileWebNativeChatReadPayload): Promise<MobileWebNativeChatReadResult> {
    return this.requests
      .request(
        'nativeChat',
        'read',
        payload,
        MobileWebNativeChatReadPayloadSchema,
        MobileWebNativeChatReadResultSchema
      )
      .then((result) => {
        if (
          result.messages.length > payload.limit ||
          (result.hasMore &&
            (result.beforeOffset === undefined ||
              (payload.beforeOffset !== undefined && result.beforeOffset >= payload.beforeOffset)))
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }

  sendMessage(
    payload: MobileWebNativeChatSendMessagePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebNativeChatSendResult> {
    return this.requests.request(
      'nativeChat',
      'sendMessage',
      payload,
      MobileWebNativeChatSendMessagePayloadSchema,
      MobileWebNativeChatSendResultSchema,
      options
    )
  }

  prepareCommit(
    payload: MobileWebNativeChatPrepareCommitPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<{ prepared: boolean }> {
    return this.requests.request(
      'nativeChat',
      'prepareCommit',
      payload,
      MobileWebNativeChatPrepareCommitPayloadSchema,
      MobileWebNativeChatPrepareCommitResultSchema,
      options
    )
  }

  respond(
    payload: MobileWebNativeChatRespondPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebNativeChatSendResult> {
    return this.requests.request(
      'nativeChat',
      'respond',
      payload,
      MobileWebNativeChatRespondPayloadSchema,
      MobileWebNativeChatSendResultSchema,
      options
    )
  }

  stop(
    payload: MobileWebNativeChatStopPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebNativeChatSendResult> {
    return this.requests.request(
      'nativeChat',
      'stop',
      payload,
      MobileWebNativeChatStopPayloadSchema,
      MobileWebNativeChatSendResultSchema,
      options
    )
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
    payload: MobileWebNativeChatFileSearchPayload
  ): Promise<MobileWebNativeChatFileSearchResult> {
    return this.requests.request(
      'nativeChat',
      'fileSearch',
      payload,
      MobileWebNativeChatFileSearchPayloadSchema,
      MobileWebNativeChatFileSearchResultSchema
    )
  }

  openFile(payload: MobileWebNativeChatOpenFilePayload): Promise<null> {
    return this.requests.request(
      'nativeChat',
      'openFile',
      payload,
      MobileWebNativeChatOpenFilePayloadSchema,
      MobileWebNativeChatOpenFileResultSchema
    )
  }

  readability(payload: MobileWebNativeChatReadabilityPayload): Promise<{ readable: boolean }> {
    return this.requests.request(
      'nativeChat',
      'readability',
      payload,
      MobileWebNativeChatReadabilityPayloadSchema,
      MobileWebNativeChatReadabilityResultSchema
    )
  }
}
