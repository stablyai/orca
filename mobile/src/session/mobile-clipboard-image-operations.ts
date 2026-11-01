import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  clipboardImagePathSchema,
  clipboardImageUnreadReplySchema,
  clipboardImageUploadSlotSchema
} from './clipboard-image-reply-schema'

// Preserve host transfer errors because the composer displays them verbatim.

// Inspect method_not_found on the raw reply to allow the older-host single-frame fallback.
export const clipboardImageUploadStart = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'clipboard.start-image-upload',
    method: 'clipboard.startImageUpload',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('clipboard-image-upload-slot', clipboardImageUploadSlotSchema)
  })
)

export const clipboardImageUploadAppend = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'clipboard.append-image-upload-chunk',
    method: 'clipboard.appendImageUploadChunk',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('clipboard-image-chunk-appended', clipboardImageUnreadReplySchema)
  })
)

export const clipboardImageUploadCommit = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'clipboard.commit-image-upload',
    method: 'clipboard.commitImageUpload',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('clipboard-image-path', clipboardImagePathSchema)
  })
)

export const clipboardImageSaveAsTempFile = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'clipboard.save-image-as-temp-file',
    method: 'clipboard.saveImageAsTempFile',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('clipboard-image-path', clipboardImagePathSchema)
  })
)

// Abort cleanup must not replace the upload error the caller is about to report.
export const clipboardImageUploadAbort = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'clipboard.abort-image-upload-or-skip',
    method: 'clipboard.abortImageUpload',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('clipboard-image-upload-aborted', clipboardImageUnreadReplySchema)
  })
)

export type MobileClipboardImageRpcSender = Parameters<typeof clipboardImageUploadStart.request>[0]
