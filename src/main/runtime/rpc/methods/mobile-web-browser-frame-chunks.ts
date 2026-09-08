import type { BrowserScreencastFrame } from '../../../../shared/browser-screencast-protocol'
import {
  MobileWebBrowserEventSchema,
  MOBILE_WEB_BROWSER_FRAME_CHUNK_BYTES,
  type MobileWebBrowserFrameChunk
} from '../../../../shared/mobile-web/browser-operation-contract'

/** The generic host lane carries JSON only, so a binary screencast frame crosses it as a run of
 * base64 chunks the page reassembles. Null when the frame cannot be described within the page
 * contract's bounds. */
export function mobileWebBrowserFrameChunks(
  frame: BrowserScreencastFrame
): MobileWebBrowserFrameChunk[] | null {
  const chunkCount = Math.ceil(frame.image.byteLength / MOBILE_WEB_BROWSER_FRAME_CHUNK_BYTES)
  const chunks: MobileWebBrowserFrameChunk[] = []
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * MOBILE_WEB_BROWSER_FRAME_CHUNK_BYTES
    const end = Math.min(frame.image.byteLength, start + MOBILE_WEB_BROWSER_FRAME_CHUNK_BYTES)
    const parsed = MobileWebBrowserEventSchema.safeParse({
      type: 'frameChunk',
      frameSequence: frame.seq,
      format: frame.format,
      metadata: frame.metadata,
      imageBytes: frame.image.byteLength,
      chunkIndex,
      chunkCount,
      data: Buffer.from(frame.image.subarray(start, end)).toString('base64')
    })
    if (!parsed.success || parsed.data.type !== 'frameChunk') {
      return null
    }
    chunks.push(parsed.data)
  }
  return chunks.length > 0 ? chunks : null
}
