import type { FileReadResult } from '../providers/types'
import { RelayErrorCode, STREAM_CHUNK_SIZE } from './relay-protocol'
import {
  defaultSshStreamAssemblyBudget,
  type SshStreamAssemblyBudget,
  base64EncodedLength
} from './ssh-stream-reader-memory'
import type { RasterImageDimensions } from '../../shared/raster-image-dimensions'
import { isRasterImagePreviewDimensions } from '../../shared/raster-image-preview-limits'

const MAX_PREVIEWABLE_BINARY_SIZE = 50 * 1024 * 1024
const MAX_TEXT_FILE_SIZE = 10 * 1024 * 1024

type FileStreamMetadata = {
  streamId?: number
  totalSize: number
  isBinary: boolean
  isImage?: boolean
  mimeType?: string
  imageDimensions?: RasterImageDimensions
  resultEncoding?: 'base64' | 'utf-8'
  empty?: boolean
}

export class StreamProtocolError extends Error {
  readonly code = RelayErrorCode.StreamProtocolError
  constructor(message: string) {
    super(message)
  }
}

export type FileStreamSetup =
  | { kind: 'empty'; result: FileReadResult }
  | { kind: 'stream'; streamId: number; assembler: FileStreamAssembler }

export function createFileStreamSetup(
  rawMetadata: unknown,
  assemblyBudget: SshStreamAssemblyBudget = defaultSshStreamAssemblyBudget
): FileStreamSetup {
  const metadata = rawMetadata as FileStreamMetadata
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    typeof metadata.isBinary !== 'boolean' ||
    !Number.isSafeInteger(metadata.totalSize) ||
    (metadata.empty !== undefined && typeof metadata.empty !== 'boolean') ||
    (metadata.isImage !== undefined && typeof metadata.isImage !== 'boolean') ||
    (metadata.mimeType !== undefined && typeof metadata.mimeType !== 'string') ||
    (metadata.imageDimensions !== undefined &&
      !isRasterImagePreviewDimensions(metadata.imageDimensions)) ||
    (metadata.resultEncoding !== undefined &&
      metadata.resultEncoding !== 'base64' &&
      metadata.resultEncoding !== 'utf-8')
  ) {
    throw new StreamProtocolError('Malformed file stream metadata')
  }
  if (metadata.empty) {
    return {
      kind: 'empty',
      result: {
        content: '',
        isBinary: metadata.isBinary,
        ...(metadata.isImage !== undefined ? { isImage: metadata.isImage } : {}),
        ...(metadata.mimeType !== undefined ? { mimeType: metadata.mimeType } : {}),
        ...(metadata.imageDimensions !== undefined
          ? { imageDimensions: metadata.imageDimensions }
          : {})
      }
    }
  }
  if (
    typeof metadata.streamId !== 'number' ||
    !Number.isSafeInteger(metadata.streamId) ||
    metadata.streamId <= 0
  ) {
    throw new StreamProtocolError('Metadata missing streamId for non-empty stream')
  }
  const cap = metadata.isBinary ? MAX_PREVIEWABLE_BINARY_SIZE : MAX_TEXT_FILE_SIZE
  if (metadata.totalSize < 0 || metadata.totalSize > cap) {
    throw new StreamProtocolError(
      `Reported totalSize ${metadata.totalSize} exceeds client cap ${cap}`
    )
  }
  return {
    kind: 'stream',
    streamId: metadata.streamId,
    assembler: new FileStreamAssembler(metadata, assemblyBudget)
  }
}

export class FileStreamAssembler {
  private buffer: Buffer | null
  private expectedSeq = 0
  private bytesReceived = 0
  private readonly totalChunks: number
  private releaseBudget: (() => void) | null

  constructor(
    private readonly metadata: FileStreamMetadata,
    assemblyBudget: SshStreamAssemblyBudget
  ) {
    this.releaseBudget = assemblyBudget.reserve(metadata.totalSize)
    if (!this.releaseBudget) {
      throw new StreamProtocolError(
        `Active SSH stream assembly would exceed ${assemblyBudget.maxBytes} bytes`
      )
    }
    try {
      this.buffer = Buffer.alloc(metadata.totalSize)
    } catch (error) {
      this.releaseMemory()
      throw new StreamProtocolError(
        `Failed to allocate ${metadata.totalSize} bytes: ${(error as Error).message}`
      )
    }
    this.totalChunks =
      metadata.totalSize === 0 ? 0 : Math.ceil(metadata.totalSize / STREAM_CHUNK_SIZE)
  }

  acceptChunk(params: Record<string, unknown>, streamId: number): number {
    const seq = params.seq
    const data = params.data
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || typeof data !== 'string') {
      throw new StreamProtocolError(`Malformed chunk for stream ${streamId}`)
    }
    if (seq !== this.expectedSeq) {
      throw new StreamProtocolError(
        `Out-of-order chunk for stream ${streamId}: expected ${this.expectedSeq}, got ${seq}`
      )
    }
    if (seq >= this.totalChunks) {
      throw new StreamProtocolError(
        `File stream ${streamId} exceeded declared chunk count ${this.totalChunks}`
      )
    }
    const offset = seq * STREAM_CHUNK_SIZE
    const expectedLength = Math.min(STREAM_CHUNK_SIZE, this.metadata.totalSize - offset)
    if (expectedLength < 0 || data.length !== base64EncodedLength(expectedLength)) {
      throw new StreamProtocolError(
        `Encoded chunk length mismatch for stream ${streamId}: seq=${seq}`
      )
    }
    const decoded = Buffer.from(data, 'base64')
    if (decoded.length !== expectedLength) {
      throw new StreamProtocolError(
        `Chunk length mismatch for stream ${streamId}: seq=${seq} expected=${expectedLength} got=${decoded.length}`
      )
    }
    if (!this.buffer) {
      throw new StreamProtocolError(`Chunk arrived after completion for stream ${streamId}`)
    }
    decoded.copy(this.buffer, offset)
    this.expectedSeq += 1
    this.bytesReceived += decoded.length
    return seq
  }

  finish(streamId: number): FileReadResult {
    if (this.expectedSeq !== this.totalChunks || this.bytesReceived !== this.metadata.totalSize) {
      throw new StreamProtocolError(
        `File stream ${streamId} incomplete: chunks ${this.expectedSeq}/${this.totalChunks}, bytes ${this.bytesReceived}/${this.metadata.totalSize}`
      )
    }
    if (!this.buffer) {
      throw new StreamProtocolError(`Stream ${streamId} already completed`)
    }
    const buffer = this.buffer
    this.buffer = null
    try {
      return {
        content:
          (this.metadata.resultEncoding ?? 'base64') === 'base64'
            ? buffer.toString('base64')
            : buffer.toString('utf-8'),
        isBinary: this.metadata.isBinary,
        ...(this.metadata.isImage !== undefined ? { isImage: this.metadata.isImage } : {}),
        ...(this.metadata.mimeType !== undefined ? { mimeType: this.metadata.mimeType } : {}),
        ...(this.metadata.imageDimensions !== undefined
          ? { imageDimensions: this.metadata.imageDimensions }
          : {})
      }
    } finally {
      this.releaseMemory()
    }
  }

  release(): void {
    this.buffer = null
    this.releaseMemory()
  }

  private releaseMemory(): void {
    this.releaseBudget?.()
    this.releaseBudget = null
  }
}
