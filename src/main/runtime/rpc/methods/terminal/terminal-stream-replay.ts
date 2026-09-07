import type { TerminalReplyQuerySequence } from '../../../../../shared/terminal-reply-query-scan'
import {
  iterateTerminalOutputFrameChunks,
  sliceTerminalOutputSourceRanges,
  type TerminalOutputFrameChunk,
  type TerminalOutputMeta
} from '../../terminal-output-frame-chunks'
import {
  measureTerminalStreamByteLength,
  terminalStreamByteLength
} from '../../terminal-stream-byte-length'
import { TERMINAL_MULTIPLEX_PENDING_MAX_BYTES } from '../../../../../shared/terminal-multiplex-flow-control'
import type { TerminalMultiplexStream, TerminalOutputChunk } from './terminal-stream-types'

export function appendPendingMultiplexOutput(
  stream: TerminalMultiplexStream,
  data: string,
  meta?: TerminalOutputMeta
): void {
  const remainingBudget = Math.max(
    1,
    TERMINAL_MULTIPLEX_PENDING_MAX_BYTES - stream.pendingOutputBytes
  )
  const measurement = measureTerminalStreamByteLength(data, {
    stopAfterBytes: remainingBudget
  })
  stream.pendingOutput.push({ data, bytes: measurement.byteLength, meta })
  stream.pendingOutputBytes += measurement.byteLength
  const trimmed = trimPendingOutputToBudget(stream.pendingOutput, stream.pendingOutputBytes)
  stream.pendingOutputBytes = trimmed.bytes
  stream.pendingOutputOverflowed ||= trimmed.overflowed
}

export function getOutputAfterSnapshotSeq(
  chunk: TerminalOutputChunk,
  snapshotSeq: number | undefined
): TerminalOutputChunk | null {
  if (
    typeof snapshotSeq !== 'number' ||
    typeof chunk.meta?.seq !== 'number' ||
    typeof chunk.meta.rawLength !== 'number'
  ) {
    return chunk
  }
  if (chunk.meta.seq <= snapshotSeq) {
    return null
  }
  const chunkStartSeq = chunk.meta.seq - chunk.meta.rawLength
  if (chunkStartSeq >= snapshotSeq) {
    return chunk
  }
  if (chunk.meta.transformed) {
    return null
  }
  const offset = snapshotSeq - chunkStartSeq
  return {
    data: chunk.data.slice(offset),
    bytes: chunk.bytes,
    meta: {
      ...chunk.meta,
      rawLength: chunk.meta.rawLength - offset,
      sourceRanges: sliceTerminalOutputSourceRanges(
        chunk.meta.sourceRanges,
        offset,
        chunk.data.length
      )
    }
  }
}

export function stripSnapshotBoundaryQuerySuffixes(
  data: string,
  dataStartSeq: number,
  snapshotSeq: number,
  queries: TerminalReplyQuerySequence[]
): string {
  let output = ''
  let offset = 0
  for (const query of queries) {
    if (query.startSeq >= snapshotSeq || query.endSeq <= snapshotSeq) {
      continue
    }
    const removeStart = Math.max(0, query.startSeq - dataStartSeq)
    const removeEnd = Math.min(data.length, query.endSeq - dataStartSeq)
    if (removeEnd <= offset || removeStart >= data.length) {
      continue
    }
    output += data.slice(offset, removeStart)
    offset = removeEnd
  }
  return output + data.slice(offset)
}

export function appendAckPendingOutput(
  stream: TerminalMultiplexStream,
  chunk: TerminalOutputFrameChunk
): void {
  stream.ackPendingOutput.push(chunk)
  stream.ackPendingOutputBytes += chunk.bytes.byteLength
  let omittedChunkCount = 0
  while (
    stream.ackPendingOutputBytes > TERMINAL_MULTIPLEX_PENDING_MAX_BYTES &&
    omittedChunkCount < stream.ackPendingOutput.length
  ) {
    stream.ackPendingOutputBytes -= stream.ackPendingOutput[omittedChunkCount]!.bytes.byteLength
    omittedChunkCount += 1
  }
  if (omittedChunkCount > 0) {
    stream.ackPendingOutput.splice(0, omittedChunkCount)
    stream.ackPendingOutputOverflowed = true
  }
}

export function trimPendingOutputToBudget(
  pendingOutput: TerminalOutputChunk[],
  pendingOutputBytes: number
): { bytes: number; overflowed: boolean } {
  let omittedChunkCount = 0
  while (
    pendingOutputBytes > TERMINAL_MULTIPLEX_PENDING_MAX_BYTES &&
    omittedChunkCount < pendingOutput.length
  ) {
    const chunk = pendingOutput[omittedChunkCount]
    pendingOutputBytes -= chunk.bytes
    omittedChunkCount += 1
  }
  if (omittedChunkCount > 0) {
    pendingOutput.splice(0, omittedChunkCount)
  }
  return { bytes: pendingOutputBytes, overflowed: omittedChunkCount > 0 }
}

export function trimPendingOutputCoveredBySnapshot(
  pendingOutput: TerminalOutputChunk[],
  snapshotSeq: number | undefined
): { chunks: TerminalOutputChunk[]; bytes: number } {
  if (typeof snapshotSeq !== 'number') {
    return {
      chunks: pendingOutput,
      bytes: pendingOutput.reduce((sum, chunk) => sum + chunk.bytes, 0)
    }
  }
  const chunks: TerminalOutputChunk[] = []
  let bytes = 0
  for (const chunk of pendingOutput) {
    const chunkSeq = chunk.meta?.seq
    const rawLength = chunk.meta?.rawLength ?? chunk.data.length
    if (typeof chunkSeq !== 'number' || rawLength !== chunk.data.length) {
      chunks.push(chunk)
      bytes += chunk.bytes
      continue
    }
    const startSeq = chunkSeq - rawLength
    if (snapshotSeq >= chunkSeq) {
      continue
    }
    if (snapshotSeq <= startSeq) {
      chunks.push(chunk)
      bytes += chunk.bytes
      continue
    }
    const data = chunk.data.slice(snapshotSeq - startSeq)
    const slicedBytes = terminalStreamByteLength(data)
    chunks.push({ data, bytes: slicedBytes, meta: undefined })
    bytes += slicedBytes
  }
  return { chunks, bytes }
}

export function* iterateTerminalStreamTextPayloads(
  data: string
): Generator<Uint8Array<ArrayBufferLike>> {
  if (!data) {
    return
  }
  for (const chunk of iterateTerminalOutputFrameChunks(data)) {
    yield chunk.bytes
  }
}

export function isTerminalReadPayloadIncomplete(read: {
  truncated: boolean
  limited?: boolean
}): boolean {
  // Why: a limited preview is an incomplete payload even when the retained buffer wasn't truncated.
  return read.truncated || read.limited === true
}

export function normalizeMultiplexSnapshotScrollbackRows(
  value: number | undefined
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return Math.max(0, Math.min(50_000, Math.floor(value)))
}

export function requestedSnapshotScrollbackCandidates(requestedRows: number | undefined): number[] {
  const candidates = [requestedRows ?? 0, 1000, 500, 250, 100, 25, 0]
    .filter((rows): rows is number => typeof rows === 'number')
    .map((rows) => Math.max(0, Math.min(50_000, Math.floor(rows))))
  return [...new Set(candidates)]
}
