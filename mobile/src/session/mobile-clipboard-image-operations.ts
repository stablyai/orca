import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  clipboardImagePathSchema,
  clipboardImageUnreadReplySchema,
  clipboardImageUploadSlotSchema
} from './clipboard-image-reply-schema'

// The chunked clipboard image upload: open a slot, append the base64 in chunks, commit, and abort
// what a failure left behind. Every leg raises the host's own message, because the composer shows
// it verbatim and has no copy of its own for a failed transfer.

/**
 * Opening an upload slot. Its refusal is read raw before interpretation: `method_not_found` is what
 * an older host answers, and a small enough image then goes over the single-frame method instead.
 * No acceptance policy carries a code, so that branch stays on the reply.
 */
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

/** The commit and the legacy single-frame write both answer the host path as a bare string. */
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

/**
 * Releasing the slot a failed upload left open. Its own outcome is discarded whatever happens — the
 * error the caller is about to rethrow is the one that matters — so it skips rather than throws and
 * cannot turn a reported failure into a different one.
 */
export const clipboardImageUploadAbort = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'clipboard.abort-image-upload-or-skip',
    method: 'clipboard.abortImageUpload',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('clipboard-image-upload-aborted', clipboardImageUnreadReplySchema)
  })
)

/** What a clipboard image send takes, named from an operation so no module names the raw port. */
export type MobileClipboardImageRpcSender = Parameters<typeof clipboardImageUploadStart.request>[0]
