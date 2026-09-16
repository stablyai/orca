import { z } from 'zod'

// The five `clipboard.*` image-upload replies. Checked against
// src/main/runtime/rpc/methods/clipboard.ts:98-194, which returns `{ uploadId }` from
// startImageUpload, `{ receivedBase64Length }` from appendImageUploadChunk, a bare path string
// from commitImageUpload and saveImageAsTempFile, and `{ aborted: true }` from abortImageUpload.

/**
 * The slot the chunk loop is addressed to.
 *
 * `uploadId` is required because mobile-clipboard-image.ts:156 destructures it and puts it in the
 * params of every append, the commit and the abort. Main cast the payload and let the destructure
 * throw a V8 TypeError whose text the composer showed; this reads as one incompatible reply.
 */
export const clipboardImageUploadSlotSchema = z.looseObject({ uploadId: z.string() })

/**
 * The host path a commit or the single-frame fallback answers with.
 *
 * A string, not a passthrough: mobile-clipboard-image.ts:112 returns it as the upload's value and
 * buildMobileImagePastePayload() calls `.split` on it, so a non-string reaches the terminal as
 * `undefined` pasted into the pane.
 */
export const clipboardImagePathSchema = z.string()

/**
 * The two replies no call site reads: the chunk acknowledgement, whose interpretation is discarded
 * at mobile-clipboard-image.ts:162, and the abort, whose request is never interpreted at all
 * (:180). Nothing is required because nothing is read — declaring the host's own members here
 * would fail a reply for a field with no consumer.
 */
export const clipboardImageUnreadReplySchema = z.unknown()
