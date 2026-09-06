import { Buffer } from 'buffer/'
import {
  MOBILE_WEB_BROWSER_FRAME_MAX_IMAGE_BYTES,
  type MobileWebBrowserFrameChunk
} from '../../../src/shared/mobile-web/browser-operation-contract'
import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame,
  type BrowserScreencastFrameMetadata
} from '../transport/browser-screencast-protocol'
import { hostSessionBrowserFrameMetadataEqual } from './host-session-browser-operations'

type PendingFrame = {
  sequence: number
  format: 'jpeg' | 'png'
  metadata: BrowserScreencastFrameMetadata
  imageBytes: number
  chunkCount: number
  chunks: Uint8Array[]
  decodedBytes: number
}

export class MobileWebBrowserFrameAssembler {
  private pending: PendingFrame | null = null

  push(chunk: MobileWebBrowserFrameChunk): BrowserScreencastFrame | null {
    if (chunk.chunkIndex === 0) {
      this.pending = {
        sequence: chunk.frameSequence,
        format: chunk.format,
        metadata: chunk.metadata,
        imageBytes: chunk.imageBytes,
        chunkCount: chunk.chunkCount,
        chunks: [],
        decodedBytes: 0
      }
    }
    const pending = this.pending
    if (
      !pending ||
      pending.sequence !== chunk.frameSequence ||
      pending.format !== chunk.format ||
      pending.imageBytes !== chunk.imageBytes ||
      pending.chunkCount !== chunk.chunkCount ||
      pending.chunks.length !== chunk.chunkIndex ||
      !hostSessionBrowserFrameMetadataEqual(pending.metadata, chunk.metadata)
    ) {
      this.pending = null
      throw new Error('Browser frame chunks are inconsistent')
    }
    const decoded = new Uint8Array(Buffer.from(chunk.data, 'base64'))
    pending.decodedBytes += decoded.byteLength
    if (
      decoded.byteLength === 0 ||
      pending.decodedBytes > pending.imageBytes ||
      pending.decodedBytes > MOBILE_WEB_BROWSER_FRAME_MAX_IMAGE_BYTES
    ) {
      this.pending = null
      throw new Error('Browser frame chunks exceed their declared size')
    }
    pending.chunks.push(decoded)
    if (pending.chunks.length !== pending.chunkCount) {
      return null
    }
    this.pending = null
    if (pending.decodedBytes !== pending.imageBytes) {
      throw new Error('Browser frame chunks do not match their declared size')
    }
    const image = new Uint8Array(pending.imageBytes)
    let offset = 0
    for (const part of pending.chunks) {
      image.set(part, offset)
      offset += part.byteLength
    }
    return {
      opcode: BrowserScreencastOpcode.Frame,
      seq: pending.sequence,
      format: pending.format,
      metadata: pending.metadata,
      image
    }
  }

  clear(): void {
    this.pending = null
  }
}
