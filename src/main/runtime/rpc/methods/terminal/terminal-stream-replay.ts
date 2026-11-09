import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences,
  type TerminalReplyQuerySequence
} from '../../../../../shared/terminal/protocol/queries/terminal-reply-query-scan'
import type { PublishedTerminalOutput } from '../../../terminal/output/terminal-published-output-ring'
import {
  iterateTerminalOutputFrameChunks,
  type TerminalOutputFrameChunk,
  type TerminalOutputMeta
} from '../../terminal-output-frame-chunks'
import {
  measureTerminalStreamByteLength,
  terminalStreamByteLength
} from '../../terminal-stream-byte-length'
import { TERMINAL_MULTIPLEX_PENDING_MAX_BYTES } from '../../../../../shared/terminal/stream/terminal-multiplex-flow-control'
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
      rawLength: chunk.meta.rawLength - offset
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

/** Joins a resume gap into one chunk ending at its last seq, without the reply queries the desktop already answered.
 * Color-scheme subscribe/withdraw are mode state, not queries, so they stay. */
export function buildResumeGapChunk(output: PublishedTerminalOutput[]): TerminalOutputChunk | null {
  const last = output.at(-1)
  if (!last) {
    return null
  }
  const joined = output.map((chunk) => chunk.data).join('')
  const { queries } = scanTerminalReplyQuerySequences(
    joined,
    0,
    EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
  )
  let data = ''
  let offset = 0
  for (const query of queries) {
    if (query.data === '\x1b[?2031h' || query.data === '\x1b[?2031l') {
      continue
    }
    data += joined.slice(offset, query.startSeq)
    offset = query.endSeq
  }
  data += joined.slice(offset)
  const rawLength = output.reduce((total, chunk) => total + chunk.rawLength, 0)
  const cwd = output.findLast((chunk) => chunk.cwd !== undefined)?.cwd
  return {
    data,
    bytes: terminalStreamByteLength(data),
    meta: {
      seq: last.seq,
      rawLength,
      ...(data.length !== rawLength || output.some((chunk) => chunk.transformed)
        ? { transformed: true }
        : {}),
      // The batcher sends this as a Metadata frame, as it did for each live chunk.
      ...(cwd !== undefined ? { cwd } : {})
    }
  }
}

export function appendAckPendingOutput(
  stream: TerminalMultiplexStream,
  chunk: TerminalOutputFrameChunk,
  maxBytes: number
): TerminalOutputFrameChunk[] {
  stream.ackPendingOutput.push(chunk)
  stream.ackPendingOutputBytes += chunk.bytes.byteLength
  const trimmed = trimHeadToBudget(
    stream.ackPendingOutput,
    stream.ackPendingOutputBytes,
    (pending) => pending.bytes.byteLength,
    maxBytes
  )
  stream.ackPendingOutputBytes = trimmed.bytes
  stream.ackPendingOutputOverflowed ||= trimmed.overflowed
  return trimmed.omitted
}

export function trimPendingOutputToBudget(
  pendingOutput: TerminalOutputChunk[],
  pendingOutputBytes: number
): { bytes: number; overflowed: boolean } {
  return trimHeadToBudget(
    pendingOutput,
    pendingOutputBytes,
    (chunk) => chunk.bytes,
    TERMINAL_MULTIPLEX_PENDING_MAX_BYTES
  )
}

function trimHeadToBudget<T>(
  items: T[],
  bytes: number,
  sizeOf: (item: T) => number,
  maxBytes: number
): { bytes: number; overflowed: boolean; omitted: T[] } {
  let omittedCount = 0
  while (bytes > maxBytes && omittedCount < items.length) {
    bytes -= sizeOf(items[omittedCount]!)
    omittedCount += 1
  }
  const omitted = omittedCount > 0 ? items.splice(0, omittedCount) : []
  return { bytes, overflowed: omittedCount > 0, omitted }
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
  for (const chunk of iterateTerminalOutputFrameChunks(data, undefined, 'text')) {
    yield chunk.bytes
  }
}

export function isTerminalReadPayloadIncomplete(read: {
  truncated: boolean
  limited?: boolean
}): boolean {
  // Limited preview is incomplete even when retained history was not truncated.
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
