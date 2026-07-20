/* oxlint-disable max-lines -- Why: terminal RPC methods are co-located for discoverability; splitting would scatter related handlers across files. */
import { z } from 'zod'
import {
  InvalidArgumentError,
  defineMethod,
  defineStreamingMethod,
  type RpcAnyMethod
} from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import type { DriverState, OrcaRuntimeService } from '../../orca-runtime'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText,
  type TerminalStreamFrame
} from '../../../../shared/terminal-stream-protocol'
import { TERMINAL_PANE_SPLIT_SOURCES } from '../../../../shared/feature-education-telemetry'
import type { TerminalOscLinkRange } from '../../../../shared/terminal-osc-link-ranges'
import {
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_INPUT_TOO_LARGE_ERROR,
  isTerminalInputTooLargeWithYield
} from '../../../../shared/terminal-input'
import { measureClipboardTextByteLength } from '../../../../shared/clipboard-text'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { isTerminalQueryReply } from '../../../../shared/terminal-query-reply'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences,
  type TerminalReplyQuerySequence,
  type TerminalReplyQueryScanState
} from '../../../../shared/terminal-reply-query-scan'
import {
  MOBILE_SNAPSHOT_BYTE_BUDGET,
  MOBILE_SUBSCRIBE_SCROLLBACK_ROWS
} from '../../scrollback-limits'
import { assertTerminalAgentSendable } from '../terminal-agent-send-guard'

const REQUESTED_SNAPSHOT_BYTE_BUDGET = 2 * 1024 * 1024
const TERMINAL_STREAM_CHUNK_BYTES = 48 * 1024
const TERMINAL_OUTPUT_FLUSH_MS = 5
// Why: output batches become binary stream payloads; byte size is the transport cost.
const TERMINAL_OUTPUT_BATCH_MAX_BYTES = 64 * 1024
// Why: remote clients can apply output pressure without pausing runtime PTY ingestion.
const TERMINAL_MULTIPLEX_ACK_STREAM_HIGH_WATER_BYTES = 512 * 1024
const TERMINAL_MULTIPLEX_ACK_TOTAL_HIGH_WATER_BYTES = 2 * 1024 * 1024
// Why: pending output is held for later binary frames, so cap the encoded
// payload bytes rather than UTF-16 code units.
const TERMINAL_MULTIPLEX_PENDING_MAX_BYTES = 256 * 1024
const TERMINAL_QUERY_REPLAY_MAX_CHARS = 16 * 1024
// Why: keep initial subscribe latency bounded; readiness remains observed after
// this deadline and triggers an in-stream recovery snapshot when it arrives.
const MOBILE_RENDERER_MOUNT_READY_TIMEOUT_MS = 3_000
let nextTerminalStreamId = 1

type SnapshotFrameOptions = {
  kind: 'scrollback' | 'resized'
  cols: number
  rows: number
  data: string
  requestId?: number
  displayMode?: string
  reason?: string
  seq?: number
  cwd?: string | null
  truncated?: boolean
  truncatedByByteBudget?: boolean
  source?: 'headless' | 'renderer'
  oscLinks?: TerminalOscLinkRange[]
  pendingEscapeTailAnsi?: string
}

type SerializedSnapshot = {
  data: string
  scrollbackAnsi?: string
  cols: number
  rows: number
  seq?: number
  cwd?: string | null
  source?: 'headless' | 'renderer'
  oscLinks?: TerminalOscLinkRange[]
  scrollbackRows: number
  truncatedByByteBudget: boolean
  pendingEscapeTailAnsi?: string
} | null

type TerminalViewportClient = {
  id: string
  type?: 'mobile' | 'desktop'
}

type TerminalMultiplexStream = {
  streamId: number
  terminal: string
  ptyId: string
  client: TerminalViewportClient | undefined
  isMobile: boolean
  ackOutput: boolean
  ackInFlightBytes: number
  supportsDesktopViewportClaims: boolean
  desktopClaimTail: Promise<boolean>
  // Why: whether THIS stream registered a remote-desktop width driver, so
  // detach only unregisters what it registered — a passive (viewport-less)
  // stream sharing a client id must not release another stream's width floor.
  registeredRemoteDesktopDriver: boolean
  remoteDesktopSubscriptionKey: string
  pendingRemoteDesktopViewport: { cols: number; rows: number } | null
  buffering: boolean
  ackPendingOutput: TerminalOutputFrameChunk[]
  ackPendingOutputBytes: number
  ackPendingOutputOverflowed: boolean
  ackRecoverySnapshotInFlight: boolean
  pendingOutput: TerminalOutputChunk[]
  pendingOutputBytes: number
  pendingOutputOverflowed: boolean
  // Why: the cols the mobile client last rewrapped to. Re-stream the full
  // scrollback only when a reflow actually changes the width.
  lastResizeCols: number | undefined
  resizeGeneration: number
  outputBatcher: ReturnType<typeof createTerminalOutputBatcher>
  unsubscribeData: () => void
  unsubscribeResize: () => void
  unsubscribeFit: () => void
  unsubscribeDriver: () => void
  unregisterBinaryHandler: () => void
  // Why: the exit-wait promise for this slot is only removed from the runtime's
  // waiter set on real PTY exit. Aborting this on detach releases it on slot
  // unsubscribe, tab-switch re-subscribe, and connection close instead of
  // leaking a waiter (and the closed-connection handler context it captures)
  // for the life of a never-exiting agent terminal.
  exitWaiterAbort: AbortController
}

type TerminalOutputChunk = {
  data: string
  bytes: number
  meta?: TerminalOutputMeta
}

type TerminalOutputMeta = {
  seq?: number
  rawLength?: number
  transformed?: boolean
  cwd?: string
}

type TerminalOutputFrameChunk = {
  bytes: Uint8Array<ArrayBufferLike>
  seq?: number
  opcode?: TerminalStreamOpcode
}

function createTerminalOutputBatcher(onFlush: (data: string, meta?: TerminalOutputMeta) => void): {
  push: (data: string, meta?: TerminalOutputMeta) => void
  flush: () => void
  dispose: () => void
} {
  let chunks: string[] = []
  let bytes = 0
  let lastSeq: number | undefined
  let pendingCwd: string | undefined
  let pendingRawLength = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = (): void => {
    if (!timer) {
      return
    }
    clearTimeout(timer)
    timer = null
  }

  const flush = (): void => {
    clearTimer()
    if (chunks.length === 0 && pendingRawLength === 0) {
      return
    }
    const data = chunks.length === 1 ? chunks[0]! : chunks.join('')
    const meta =
      typeof lastSeq === 'number' || pendingCwd !== undefined
        ? {
            ...(typeof lastSeq === 'number' ? { seq: lastSeq, rawLength: pendingRawLength } : {}),
            ...(pendingCwd !== undefined ? { cwd: pendingCwd } : {})
          }
        : undefined
    chunks = []
    bytes = 0
    lastSeq = undefined
    pendingCwd = undefined
    pendingRawLength = 0
    onFlush(data, meta)
  }

  return {
    push(data: string, meta?: TerminalOutputMeta): void {
      const rawLength = meta?.rawLength ?? data.length
      if (!data && rawLength === 0) {
        return
      }
      if (meta?.transformed || rawLength !== data.length) {
        flush()
        onFlush(data, { ...meta, rawLength, transformed: true })
        return
      }
      if (meta?.cwd !== undefined) {
        flush()
        pendingCwd = meta.cwd
      }
      chunks.push(data)
      pendingRawLength += rawLength
      const remainingBudget = Math.max(1, TERMINAL_OUTPUT_BATCH_MAX_BYTES - bytes)
      const measurement = measureTerminalStreamByteLength(data, {
        stopAfterBytes: remainingBudget
      })
      bytes += measurement.byteLength
      if (typeof meta?.seq === 'number') {
        lastSeq = meta.seq
      }
      if (measurement.exceededLimit || bytes >= TERMINAL_OUTPUT_BATCH_MAX_BYTES) {
        flush()
        return
      }
      if (!timer) {
        // Why: terminal stream output should be coalesced before crossing the
        // network. Desktop runtime subscribers need the same burst boundary.
        timer = setTimeout(flush, TERMINAL_OUTPUT_FLUSH_MS)
        if (typeof timer.unref === 'function') {
          timer.unref()
        }
      }
    },
    flush,
    dispose(): void {
      clearTimer()
      chunks = []
      bytes = 0
      pendingRawLength = 0
    }
  }
}

function* iterateTerminalOutputFrameChunks(
  data: string,
  meta?: TerminalOutputMeta
): Generator<TerminalOutputFrameChunk> {
  const rawLength = meta?.rawLength ?? data.length
  if (meta?.transformed || rawLength !== data.length) {
    yield {
      opcode: TerminalStreamOpcode.OutputSpan,
      bytes: encodeTerminalStreamJson({ data, rawLength, transformed: true }),
      seq: meta?.seq
    }
    return
  }
  if (!terminalStreamByteLengthExceeds(data, TERMINAL_STREAM_CHUNK_BYTES)) {
    yield { bytes: encodeTerminalStreamText(data), seq: meta?.seq }
    return
  }
  const canPreserveChunkSeq = typeof meta?.seq === 'number' && rawLength === data.length
  const shouldDelayFinalSeq = !canPreserveChunkSeq && typeof meta?.seq === 'number'
  const startSeq = canPreserveChunkSeq ? meta.seq! - rawLength : undefined
  let chunk = ''
  let chunkBytes = 0
  let chunkStartOffset = 0
  let offset = 0
  let delayedChunk: { text: string; seq?: number } | null = null

  const takeChunk = (): { text: string; seq?: number } | null => {
    if (!chunk) {
      return null
    }
    const chunkSeq = canPreserveChunkSeq ? startSeq! + chunkStartOffset + chunk.length : undefined
    const current = { text: chunk, seq: chunkSeq }
    chunk = ''
    chunkBytes = 0
    chunkStartOffset = offset
    return current
  }

  for (const part of data) {
    const partBytes = terminalStreamByteLength(part)
    if (chunkBytes > 0 && chunkBytes + partBytes > TERMINAL_STREAM_CHUNK_BYTES) {
      const nextChunk = takeChunk()
      if (nextChunk) {
        if (shouldDelayFinalSeq) {
          if (delayedChunk) {
            yield { bytes: encodeTerminalStreamText(delayedChunk.text) }
          }
          delayedChunk = nextChunk
        } else {
          yield { bytes: encodeTerminalStreamText(nextChunk.text), seq: nextChunk.seq }
        }
      }
    }
    chunk += part
    chunkBytes += partBytes
    offset += part.length
  }
  const finalChunk = takeChunk()
  if (shouldDelayFinalSeq) {
    // Why: if a future caller reports rawLength that cannot be mapped back to
    // UTF-16 offsets, only the final frame can safely carry the high-water mark.
    if (finalChunk) {
      if (delayedChunk) {
        yield { bytes: encodeTerminalStreamText(delayedChunk.text) }
      }
      delayedChunk = finalChunk
    }
    if (delayedChunk) {
      yield { bytes: encodeTerminalStreamText(delayedChunk.text), seq: meta.seq }
    }
    return
  }
  if (finalChunk) {
    yield { bytes: encodeTerminalStreamText(finalChunk.text), seq: finalChunk.seq }
  }
}

function isTerminalInputLockedForClient(
  runtime: OrcaRuntimeService,
  ptyId: string,
  client: TerminalViewportClient | undefined
): boolean {
  if (client?.type === 'mobile') {
    return false
  }
  // Why: pre-refactor mobile builds did not send client metadata. Desktop
  // callers we control now identify as desktop, so keep legacy mobile input
  // working without opening the new desktop path.
  if (!client) {
    return false
  }
  return runtime.getDriver(ptyId).kind === 'mobile'
}

async function assertTerminalSendTextWithinLimit(text: string | undefined): Promise<void> {
  if (!text) {
    return
  }
  // Why: runtime/mobile sends can be paste-sized; validate outside Zod so
  // accepted large input yields before terminal runtime dispatch.
  if (await isTerminalInputTooLargeWithYield(text, TERMINAL_INPUT_MAX_BYTES)) {
    throw new InvalidArgumentError(TERMINAL_INPUT_TOO_LARGE_ERROR)
  }
}

function resolveMobileFloorClientId(
  driver: DriverState | null,
  client: TerminalViewportClient | undefined
): string | null {
  if (client?.type === 'mobile') {
    return client.id
  }
  if (!client && driver?.kind === 'mobile') {
    return driver.clientId
  }
  return null
}

async function sendTerminalStreamInput(
  runtime: OrcaRuntimeService,
  args: {
    terminal: string
    text: string
    client: TerminalViewportClient | undefined
    isMobile: boolean
  }
): Promise<void> {
  const action = { text: args.text, enter: false, interrupt: false }
  const clientId = args.isMobile ? args.client?.id : undefined
  const floorClaim: MobileInputFloorClaimHolder = { current: null }
  try {
    if (!clientId) {
      await runtime.sendTerminal(args.terminal, action)
      return
    }
    const result = await runtime.sendTerminal(args.terminal, action, {
      reserveWrite: (writePtyId) => {
        const claim = runtime.beginMobileInputFloor(writePtyId, clientId)
        if (!claim) {
          throw new Error('mobile_input_floor_unavailable')
        }
        floorClaim.current = claim
      },
      afterWrite: () => commitMobileInputFloorClaim(floorClaim)
    })
    if (!result.accepted) {
      floorClaim.current?.rollback()
    }
  } catch {
    floorClaim.current?.rollback()
  }
}

type MobileInputFloorClaimHolder = {
  current: ReturnType<OrcaRuntimeService['beginMobileInputFloor']>
}

async function commitMobileInputFloorClaim(claim: MobileInputFloorClaimHolder): Promise<void> {
  const current = claim.current
  if (!current) {
    return
  }
  try {
    await current.commit()
  } finally {
    // Why: the runtime may yield before the next chunk/suffix, so that write
    // needs a fresh reservation if desktop reclaimed the floor meanwhile.
    if (claim.current === current) {
      claim.current = null
    }
  }
}

function getTerminalSendGuardRefusedReason(error: unknown): 'no-agent' | 'permission' | undefined {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('terminal_guard_permission')) {
    return 'permission'
  }
  if (message.includes('terminal_guard_no_agent')) {
    return 'no-agent'
  }
  return undefined
}

function isTerminalSendGuardNotWritable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('terminal_guard_not_writable')
}

function assertTerminalSendExactPtyBinding(
  runtime: OrcaRuntimeService,
  handle: string,
  expectedPtyId: string | undefined
): void {
  try {
    if (expectedPtyId && runtime.resolveLiveLeafForHandle(handle)?.ptyId === expectedPtyId) {
      return
    }
  } catch {
    // Fall through to the stable guarded-send result below.
  }
  throw new Error('terminal_guard_not_writable')
}

function appendPendingMultiplexOutput(
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

function getOutputAfterSnapshotSeq(
  chunk: TerminalOutputChunk,
  snapshotSeq: number | undefined
): string | null {
  if (
    typeof snapshotSeq !== 'number' ||
    typeof chunk.meta?.seq !== 'number' ||
    typeof chunk.meta.rawLength !== 'number'
  ) {
    return chunk.data
  }
  if (chunk.meta.seq <= snapshotSeq) {
    return null
  }
  const chunkStartSeq = chunk.meta.seq - chunk.meta.rawLength
  if (chunkStartSeq >= snapshotSeq) {
    return chunk.data
  }
  return chunk.data.slice(snapshotSeq - chunkStartSeq)
}

function stripSnapshotBoundaryQuerySuffixes(
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

function appendAckPendingOutput(
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

function trimPendingOutputToBudget(
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

function measureTerminalStreamByteLength(
  data: string,
  options: { stopAfterBytes?: number } = {}
): { byteLength: number; exceededLimit: boolean } {
  return measureClipboardTextByteLength(data, options)
}

function trimPendingOutputCoveredBySnapshot(
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

function terminalStreamByteLength(data: string): number {
  return measureTerminalStreamByteLength(data).byteLength
}

function terminalStreamByteLengthExceeds(data: string, maxBytes: number): boolean {
  return measureTerminalStreamByteLength(data, { stopAfterBytes: maxBytes }).exceededLimit
}

function* iterateTerminalStreamTextPayloads(data: string): Generator<Uint8Array<ArrayBufferLike>> {
  if (!data) {
    return
  }
  for (const chunk of iterateTerminalOutputFrameChunks(data)) {
    yield chunk.bytes
  }
}

function isTerminalReadPayloadIncomplete(read: { truncated: boolean; limited?: boolean }): boolean {
  // Why: uncursored terminal reads are bounded previews; limited previews are
  // incomplete stream payloads even when the retained buffer was not truncated.
  return read.truncated || read.limited === true
}

function normalizeMultiplexSnapshotScrollbackRows(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return Math.max(0, Math.min(50_000, Math.floor(value)))
}

function requestedSnapshotScrollbackCandidates(requestedRows: number | undefined): number[] {
  const candidates = [requestedRows ?? 0, 1000, 500, 250, 100, 25, 0]
    .filter((rows): rows is number => typeof rows === 'number')
    .map((rows) => Math.max(0, Math.min(50_000, Math.floor(rows))))
  return [...new Set(candidates)]
}

async function serializeBudgetedRequestedSnapshot(
  runtime: OrcaRuntimeService,
  ptyId: string,
  scrollbackRows: number | undefined
): Promise<SerializedSnapshot> {
  const requestedRows = scrollbackRows ?? 0
  for (const rows of requestedSnapshotScrollbackCandidates(scrollbackRows)) {
    const serialized = await runtime.serializeTerminalBuffer(ptyId, { scrollbackRows: rows })
    if (!serialized) {
      return null
    }
    const data = (serialized.scrollbackAnsi ?? '') + serialized.data
    const overByteBudget = terminalStreamByteLengthExceeds(data, REQUESTED_SNAPSHOT_BYTE_BUDGET)
    if (!overByteBudget || rows === 0) {
      return {
        ...serialized,
        data,
        scrollbackRows: rows,
        truncatedByByteBudget: rows < requestedRows || overByteBudget
      }
    }
  }
  return null
}

function sendSnapshotFrames(
  sendFrame: (opcode: TerminalStreamOpcode, payload?: Uint8Array<ArrayBufferLike>) => void,
  options: SnapshotFrameOptions
): { bytes: number; chunks: number } {
  sendFrame(
    TerminalStreamOpcode.SnapshotStart,
    encodeTerminalStreamJson({
      kind: options.kind,
      cols: options.cols,
      rows: options.rows,
      requestId: options.requestId,
      displayMode: options.displayMode,
      reason: options.reason,
      seq: options.seq,
      cwd: options.cwd,
      source: options.source,
      oscLinks: options.oscLinks,
      pendingEscapeTailAnsi: options.pendingEscapeTailAnsi,
      truncated: options.truncated === true,
      truncatedByByteBudget: options.truncatedByByteBudget === true
    })
  )
  let chunks = 0
  let bytes = 0
  for (const chunk of iterateTerminalStreamTextPayloads(options.data)) {
    chunks++
    bytes += chunk.byteLength
    sendFrame(TerminalStreamOpcode.SnapshotChunk, chunk)
  }
  sendFrame(TerminalStreamOpcode.SnapshotEnd)
  return { bytes, chunks }
}

async function serializeBudgetedMobileSnapshot(
  runtime: OrcaRuntimeService,
  ptyId: string,
  isMobile: boolean
): Promise<SerializedSnapshot> {
  if (!isMobile) {
    const serialized = await runtime.serializeTerminalBuffer(ptyId, { scrollbackRows: 0 })
    return serialized
      ? {
          ...serialized,
          data: (serialized.scrollbackAnsi ?? '') + serialized.data,
          scrollbackRows: 0,
          truncatedByByteBudget: false
        }
      : null
  }
  const candidates = [MOBILE_SUBSCRIBE_SCROLLBACK_ROWS, 500, 250, 100, 25, 0]
  for (const rows of candidates) {
    const serialized = await runtime.serializeTerminalBuffer(ptyId, { scrollbackRows: rows })
    if (!serialized) {
      return null
    }
    const data = (serialized.scrollbackAnsi ?? '') + serialized.data
    const overByteBudget = terminalStreamByteLengthExceeds(data, MOBILE_SNAPSHOT_BYTE_BUDGET)
    if (!overByteBudget || rows === 0) {
      return {
        ...serialized,
        data,
        scrollbackRows: rows,
        truncatedByByteBudget: rows < MOBILE_SUBSCRIBE_SCROLLBACK_ROWS || overByteBudget
      }
    }
  }
  return null
}

async function serializeStableMobileRendererSnapshot(
  runtime: OrcaRuntimeService,
  ptyId: string
): Promise<SerializedSnapshot> {
  const candidates = [MOBILE_SUBSCRIBE_SCROLLBACK_ROWS, 500, 250, 100, 25, 0]
  let candidateIndex = 0
  for (let attempt = 0; attempt < candidates.length; attempt += 1) {
    // Why: stability retries share the six-call snapshot budget. Advance
    // toward zero scrollback so the final attempt always has a bounded payload.
    candidateIndex = Math.max(candidateIndex, attempt)
    const rows = candidates[candidateIndex]
    const outputSequenceBefore = runtime.getPtyOutputSequence(ptyId)
    const serialized = await runtime.serializeRendererTerminalBuffer(ptyId, {
      scrollbackRows: rows
    })
    const outputSequenceAfter = runtime.getPtyOutputSequence(ptyId)
    if (outputSequenceBefore !== outputSequenceAfter) {
      continue
    }
    if (!serialized) {
      return null
    }
    const overByteBudget = terminalStreamByteLengthExceeds(
      serialized.data,
      MOBILE_SNAPSHOT_BYTE_BUDGET
    )
    if (!overByteBudget || rows === 0) {
      return {
        ...serialized,
        scrollbackRows: rows,
        truncatedByByteBudget: rows < MOBILE_SUBSCRIBE_SCROLLBACK_ROWS || overByteBudget
      }
    }
    candidateIndex += 1
  }
  return null
}

// Why: mobile xterm can only re-wrap SOFT-wrapped lines on a client-side
// term.resize(); the restored scrollback snapshot contains HARD newlines from
// the host serialization, so a width change leaves prior output wrapped at the
// old column count. On a real reflow we re-serialize the FULL buffer at the new
// cols and replay it, so scrollback rewraps. Alt-screen TUIs are PTY-repainted
// and have no scrollback, so they keep the geometry-only Resized frame.
async function sendMobileResizeRestream(
  runtime: OrcaRuntimeService,
  ptyId: string,
  sendFrame: (opcode: TerminalStreamOpcode, payload?: Uint8Array<ArrayBufferLike>) => void,
  event: { cols: number; rows: number; displayMode: string; reason: string; seq?: number },
  shouldSend?: () => boolean
): Promise<boolean> {
  // Why: only a true PTY geometry reflow rewraps scrollback; mode-change ticks
  // that did not change dims would re-send the whole buffer for nothing.
  if (event.reason !== 'apply-layout' || runtime.isTerminalAlternateScreen(ptyId)) {
    return false
  }
  const serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, true)
  if (!serialized) {
    return false
  }
  if (shouldSend && !shouldSend()) {
    return true
  }
  sendSnapshotFrames(sendFrame, {
    kind: 'resized',
    cols: serialized.cols,
    rows: serialized.rows,
    displayMode: event.displayMode,
    reason: event.reason,
    seq: event.seq ?? serialized.seq,
    source: serialized.source,
    cwd: serialized.cwd,
    oscLinks: serialized.oscLinks,
    truncated: false,
    truncatedByByteBudget: serialized.truncatedByByteBudget,
    data: serialized.data
  })
  return true
}

async function updateViewportForClient(
  runtime: OrcaRuntimeService,
  ptyId: string,
  subscriptionKey: string,
  client: TerminalViewportClient,
  viewport: { cols: number; rows: number },
  defaultType: 'mobile' | 'desktop',
  // Why: the one-shot `terminal.updateViewport` RPC has no disconnect hook, so
  // it must only refresh a floor the client already owns via its stream (never
  // create a leak-prone standalone one). Stream paths that own cleanup register.
  registration: 'register' | 'refresh' = 'register',
  claim = false
): Promise<{ updated: boolean; applied: boolean }> {
  const type = client.type ?? defaultType
  if (type === 'mobile') {
    return runtime.updateMobileViewport(ptyId, client.id, viewport)
  }
  // Why: stream attachment observes geometry without taking control. Only a
  // later activity/claim frame may make this desktop authoritative.
  const updated =
    registration === 'refresh'
      ? await runtime.refreshRemoteDesktopViewer(
          ptyId,
          client.id,
          viewport.cols,
          viewport.rows,
          claim
        )
      : await runtime.updateRemoteDesktopViewer(
          ptyId,
          subscriptionKey,
          client.id,
          viewport.cols,
          viewport.rows,
          claim
        )
  return { updated, applied: updated }
}

const TerminalHandle = z.object({
  terminal: requiredString('Missing terminal handle')
})

const TerminalListParams = z.object({
  worktree: OptionalString,
  limit: OptionalFiniteNumber,
  requireFreshPtyLiveness: z.boolean().optional()
})

const TerminalResolveActive = z.object({
  worktree: OptionalString
})

const TerminalResolvePane = z.object({
  paneKey: requiredString('Missing pane key')
})

const TerminalRead = TerminalHandle.extend({
  cursor: z
    .unknown()
    .transform((value) => {
      if (value === undefined) {
        return undefined
      }
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return Number.NaN
      }
      return value
    })
    .pipe(
      z
        .number()
        .optional()
        .refine((v) => v === undefined || Number.isFinite(v), {
          message: 'Cursor must be a non-negative integer'
        })
    )
    .optional(),
  limit: OptionalFiniteNumber
})

// Why: the legacy handler allowed `title: string | null` and rejected every
// other shape (including `undefined`) with a specific message, which is how
// the CLI signals an intentional "reset". Preserve that distinction exactly.
const TerminalRename = TerminalHandle.extend({
  title: z.custom<string | null>((value) => value === null || typeof value === 'string', {
    message: 'Missing --title (pass empty string or null to reset)'
  })
})

const TerminalSend = TerminalHandle.extend({
  text: OptionalString,
  enter: z.unknown().optional(),
  interrupt: z.unknown().optional(),
  requireAgentStatus: z.enum(['sendable']).optional(),
  // Why: terminal-generated replies are valid input bytes but are not a user
  // action that should transfer the shared terminal floor.
  inputKind: z.enum(['query-reply']).optional(),
  // Why: identifies the caller for the driver state machine. Optional for
  // backward compatibility with older mobile clients (server falls back to
  // the most recent mobile actor when absent). New mobile builds populate
  // this so multi-mobile semantics resolve correctly. See
  // docs/mobile-presence-lock.md.
  client: z
    .object({
      id: requiredString('Missing client ID'),
      type: z.enum(['mobile', 'desktop']).default('desktop').optional()
    })
    .optional(),
  viewport: z
    .object({
      cols: z.number().int().min(1).max(1000),
      rows: z.number().int().min(1).max(500)
    })
    .optional(),
  claimViewport: z.literal(true).optional()
})

const TerminalViewport = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(500)
})

const TerminalWait = TerminalHandle.extend({
  for: z.custom<'exit' | 'tui-idle'>((value) => value === 'exit' || value === 'tui-idle', {
    message: 'Invalid --for value. Supported: exit, tui-idle'
  }),
  timeoutMs: OptionalFiniteNumber
})

const TerminalCreateParams = z.object({
  worktree: OptionalString,
  command: OptionalString,
  startupCommandDelivery: z.enum(['fast', 'shell-ready']).optional(),
  env: z.record(z.string(), z.string()).optional(),
  launchConfig: z
    .object({
      agentCommand: z.string().optional(),
      agentArgs: z.string(),
      agentEnv: z.record(z.string(), z.string())
    })
    .optional(),
  launchToken: OptionalString,
  launchAgent: z.string().refine(isTuiAgent).optional(),
  title: OptionalString,
  focus: z.unknown().optional(),
  rendererBacked: z.unknown().optional(),
  activate: z.unknown().optional(),
  presentation: z.enum(['background', 'focused']).optional(),
  tabId: OptionalString,
  leafId: OptionalString
})

const TerminalSplit = TerminalHandle.extend({
  direction: z
    .unknown()
    .transform((v) => (v === 'vertical' || v === 'horizontal' ? v : undefined))
    .pipe(z.union([z.enum(['vertical', 'horizontal']), z.undefined()]))
    .optional(),
  command: OptionalString,
  env: z.record(z.string(), z.string()).optional(),
  telemetrySource: z.enum(TERMINAL_PANE_SPLIT_SOURCES).optional()
})

const TerminalStop = z.object({
  worktree: requiredString('Missing worktree selector')
})

const TerminalStopExact = TerminalStop.extend({
  expectedPtyIds: z.array(requiredString('Missing PTY ID')).min(1),
  keepHistory: z.boolean().optional(),
  targetOnly: z.boolean().optional()
})

const AgentTeamsTmuxCompat = z.object({
  teamId: requiredString('Missing agent team ID'),
  token: requiredString('Missing agent team token'),
  envPane: requiredString('Missing tmux pane identity'),
  cwd: OptionalString,
  argv: z.array(z.string())
})

const AgentTeamsPrepareLaunch = z.object({
  paneKey: requiredString('Missing pane key'),
  env: z.record(z.string(), z.string()).optional()
})

const TerminalResizeForClient = z.discriminatedUnion('mode', [
  z.object({
    terminal: requiredString('Missing terminal handle'),
    mode: z.literal('mobile-fit'),
    cols: z.number().finite().positive(),
    rows: z.number().finite().positive(),
    clientId: requiredString('Missing client ID')
  }),
  z.object({
    terminal: requiredString('Missing terminal handle'),
    mode: z.literal('restore'),
    clientId: requiredString('Missing client ID')
  })
])

const TerminalSubscribe = TerminalHandle.extend({
  client: z
    .object({
      id: requiredString('Missing client ID'),
      type: z.enum(['mobile', 'desktop']).default('desktop')
    })
    .optional(),
  viewport: TerminalViewport.optional(),
  capabilities: z
    .object({
      terminalBinaryStream: z.literal(1).optional(),
      desktopViewportClaims: z.literal(1).optional(),
      mobileInputLeaseOnly: z.literal(1).optional()
    })
    .optional()
})

const TerminalMultiplex = z.object({})

const TerminalMultiplexSubscribeFrame = TerminalHandle.extend({
  streamId: z.number().int().min(1),
  client: z
    .object({
      id: requiredString('Missing client ID'),
      type: z.enum(['mobile', 'desktop']).default('desktop')
    })
    .optional(),
  viewport: TerminalViewport.optional(),
  capabilities: z
    .object({
      ackOutput: z.literal(1).optional(),
      desktopViewportClaims: z.literal(1).optional()
    })
    .optional()
})

const TerminalMultiplexAckFrame = z.object({
  bytes: z.number().int().nonnegative()
})

const TerminalMultiplexSnapshotRequestFrame = z.object({
  requestId: z.number().int().positive().optional(),
  scrollbackRows: z.number().finite().optional()
})

const TerminalSetDisplayMode = TerminalHandle.extend({
  // Why: 'phone' was previously a "stay at phone dims after unsubscribe"
  // mode that the toggle UI never produced and nothing in product
  // depended on. Removed in favor of two clean modes: 'auto' (mobile
  // drives dims while subscribed, desktop restores on last-leave) and
  // 'desktop' (no resize, mobile scales the wide canvas down to fit).
  mode: z.enum(['auto', 'desktop']),
  // Why: identifies the caller for the driver state machine. Optional for
  // backward compatibility with older mobile clients.
  client: z
    .object({
      id: requiredString('Missing client ID'),
      type: z.enum(['mobile', 'desktop']).default('desktop').optional()
    })
    .optional(),
  // Why: subscribers that registered before viewport was measured have
  // a null viewport on their record. Toggling to 'auto' would no-op
  // because applyMobileDisplayMode skips phone-fit when viewport is
  // missing. Allow the toggle to carry the latest measured viewport so
  // the server can store it on the subscriber record before fitting.
  viewport: z
    .object({
      cols: z.number().int().positive(),
      rows: z.number().int().positive()
    })
    .optional()
})

const TerminalUnsubscribe = z.object({
  subscriptionId: requiredString('Missing subscription ID'),
  // Why: required when subscribe registered the cleanup under the composite
  // key `${terminal}:${clientId}`. If the caller passes a bare-handle
  // subscriptionId (older clients), the server reconstructs the composite
  // key from `client.id`. See docs/mobile-presence-lock.md.
  client: z
    .object({
      id: requiredString('Missing client ID')
    })
    .optional()
})

// Why: in-place viewport update for an existing mobile subscription. Used
// when the keyboard opens/closes on the mobile client and the visible
// terminal area changes — without this, the mobile app had to
// unsubscribe → resubscribe, which (a) flashed the desktop lock banner
// during the brief idle gap and (b) caused the new subscribe to capture
// the already-phone-fitted PTY size as its restore baseline, leaving the
// PTY stuck at phone dims after the phone disconnected. See
// docs/mobile-presence-lock.md.
const TerminalUpdateViewport = TerminalHandle.extend({
  client: z.object({
    id: requiredString('Missing client ID'),
    type: z.enum(['mobile', 'desktop']).default('mobile').optional()
  }),
  viewport: z.object({
    cols: z.number().int().min(20).max(240),
    rows: z.number().int().min(8).max(120)
  }),
  claim: z.boolean().optional()
})

// Why: phone-fit auto-restore preference (docs/mobile-fit-hold.md). `null`
// means Indefinite; finite millisecond values are clamped server-side
// into [5_000, 60min] before persistence.
const TerminalSetAutoRestoreFit = z.object({
  ms: z.number().nullable()
})

export const TERMINAL_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.list',
    params: TerminalListParams,
    handler: async (params, { runtime }) =>
      runtime.listTerminals(params.worktree, params.limit, {
        requireFreshPtyLiveness: params.requireFreshPtyLiveness
      })
  }),
  defineMethod({
    name: 'terminal.resolveActive',
    params: TerminalResolveActive,
    handler: async (params, { runtime }) => ({
      handle: await runtime.resolveActiveTerminal(params.worktree)
    })
  }),
  defineMethod({
    name: 'terminal.resolvePane',
    params: TerminalResolvePane,
    handler: async (params, { runtime }) => ({
      terminal: runtime.resolveTerminalPane(params.paneKey)
    })
  }),
  defineMethod({
    name: 'terminal.show',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      terminal: await runtime.showTerminal(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.read',
    params: TerminalRead,
    handler: async (params, { runtime }) => ({
      terminal: await runtime.readTerminal(params.terminal, {
        cursor: params.cursor,
        limit: params.limit
      })
    })
  }),
  defineMethod({
    name: 'terminal.inspectProcess',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      process: await runtime.inspectTerminalProcess(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.isRunningAgent',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      isRunningAgent: await runtime.isTerminalRunningAgent(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.agentStatus',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      agentStatus: await runtime.getTerminalAgentStatus(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.rename',
    params: TerminalRename,
    handler: async (params, { runtime }) => ({
      rename: await runtime.renameTerminal(params.terminal, params.title || null)
    })
  }),
  defineMethod({
    name: 'terminal.clearBuffer',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      clear: await runtime.clearTerminalBuffer(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.send',
    params: TerminalSend,
    handler: async (params, { runtime, clientId }) => {
      await assertTerminalSendTextWithinLimit(params.text)
      const queryReplyClientId = clientId ?? params.client?.id
      if (
        params.inputKind === 'query-reply' &&
        (!params.text ||
          !isTerminalQueryReply(params.text) ||
          params.enter === true ||
          params.interrupt === true ||
          params.requireAgentStatus !== undefined ||
          params.client?.type !== 'mobile' ||
          !queryReplyClientId ||
          (clientId !== undefined && params.client.id !== clientId))
      ) {
        throw new InvalidArgumentError('Invalid terminal query reply')
      }
      // Why: guarded resolution — a stale handle must fail with
      // terminal_handle_stale (clients recover by re-deriving the handle)
      // instead of evaluating driver/lock state against the wrong PTY (#7718).
      const leaf = runtime.resolveLiveLeafForHandle(params.terminal)
      const driver = leaf?.ptyId ? runtime.getDriver(leaf.ptyId) : null
      if (
        params.inputKind === 'query-reply' &&
        leaf?.ptyId &&
        !runtime.isMobileTerminalQueryReplyAuthority(leaf.ptyId, queryReplyClientId!)
      ) {
        return {
          send: {
            handle: params.terminal,
            accepted: false,
            bytesWritten: 0
          }
        }
      }
      if (leaf?.ptyId && isTerminalInputLockedForClient(runtime, leaf.ptyId, params.client)) {
        return {
          send: {
            handle: params.terminal,
            accepted: false,
            bytesWritten: 0
          }
        }
      }
      if (
        leaf?.ptyId &&
        params.client?.type === 'desktop' &&
        params.claimViewport === true &&
        params.viewport
      ) {
        const claim = await updateViewportForClient(
          runtime,
          leaf.ptyId,
          `send:${params.client.id}`,
          params.client,
          params.viewport,
          'desktop',
          'refresh',
          true
        )
        // Why: a stream-less request has no lifecycle cleanup and cannot safely
        // create ownership. Never write at stale geometry if no stream exists.
        if (!claim.updated || isTerminalInputLockedForClient(runtime, leaf.ptyId, params.client)) {
          return {
            send: {
              handle: params.terminal,
              accepted: false,
              bytesWritten: 0
            }
          }
        }
      }
      const hasText = typeof params.text === 'string' && params.text.length > 0
      const hasSuffix = params.enter === true || params.interrupt === true
      if (params.requireAgentStatus === 'sendable' && hasText && hasSuffix) {
        // Why: guarded sends are two-phase writes. Reject combined payload +
        // submit so guard flips cannot create ambiguous partial delivery.
        return {
          send: {
            handle: params.terminal,
            accepted: false,
            bytesWritten: 0
          }
        }
      }
      // Why: selected note sends submit with Enter. The runtime must recheck
      // permission/no-agent state immediately before accepting the PTY write.
      const assertSendPreconditions =
        params.requireAgentStatus === 'sendable'
          ? async (ptyId?: string): Promise<void> => {
              await assertTerminalAgentSendable({
                runtime,
                handle: params.terminal,
                assertWritable: () => {
                  assertTerminalSendExactPtyBinding(runtime, params.terminal, ptyId)
                  if (ptyId && isTerminalInputLockedForClient(runtime, ptyId, params.client)) {
                    throw new Error('terminal_guard_not_writable')
                  }
                }
              })
            }
          : undefined
      if (params.requireAgentStatus === 'sendable') {
        try {
          await assertSendPreconditions?.(leaf?.ptyId ?? undefined)
        } catch (error) {
          if (isTerminalSendGuardNotWritable(error)) {
            return {
              send: {
                handle: params.terminal,
                accepted: false,
                bytesWritten: 0
              }
            }
          }
          const refusedReason = getTerminalSendGuardRefusedReason(error)
          if (!refusedReason) {
            throw error
          }
          return {
            send: {
              handle: params.terminal,
              accepted: false,
              bytesWritten: 0,
              refusedReason
            }
          }
        }
      }
      const mobileFloorClientId = resolveMobileFloorClientId(driver, params.client)
      const mobileFloorClaim: MobileInputFloorClaimHolder = { current: null }
      const beforeWrite = assertSendPreconditions
      const reserveWrite =
        params.inputKind !== 'query-reply' && leaf?.ptyId && mobileFloorClientId
          ? (ptyId: string): void => {
              const claim = runtime.beginMobileInputFloor(ptyId, mobileFloorClientId)
              if (!claim) {
                throw new Error('mobile_input_floor_unavailable')
              }
              mobileFloorClaim.current = claim
            }
          : undefined
      let result
      try {
        result = await runtime.sendTerminal(
          params.terminal,
          {
            text: params.text,
            enter: params.enter === true,
            interrupt: params.interrupt === true
          },
          {
            beforeWrite,
            ...(reserveWrite ? { reserveWrite } : {}),
            ...(params.inputKind !== 'query-reply' && mobileFloorClientId
              ? { afterWrite: () => commitMobileInputFloorClaim(mobileFloorClaim) }
              : {})
          }
        )
      } catch (error) {
        mobileFloorClaim.current?.rollback()
        const refusedReason = getTerminalSendGuardRefusedReason(error)
        if (refusedReason) {
          return {
            send: {
              handle: params.terminal,
              accepted: false,
              bytesWritten: 0,
              refusedReason
            }
          }
        }
        if (isTerminalSendGuardNotWritable(error)) {
          return {
            send: {
              handle: params.terminal,
              accepted: false,
              bytesWritten: 0
            }
          }
        }
        throw error
      }
      if (result.accepted !== true) {
        mobileFloorClaim.current?.rollback()
      }
      // Why: deliberate mobile input is a take-floor action. Drives the
      // `* → mobile{clientId}` driver transition so the desktop banner
      // remounts (if previously reclaimed) and active phone-fit dims follow
      // the most recent actor. Clientless sends are old mobile builds, so use
      // the current mobile driver as their compatibility identity.
      return { send: result }
    }
  }),
  defineMethod({
    name: 'terminal.wait',
    params: TerminalWait,
    handler: async (params, { runtime, signal }) => ({
      wait: await runtime.waitForTerminal(params.terminal, {
        condition: params.for,
        timeoutMs: params.timeoutMs,
        signal
      })
    })
  }),
  defineMethod({
    name: 'terminal.create',
    params: TerminalCreateParams,
    handler: async (params, { runtime }) => ({
      terminal: await runtime.createTerminal(params.worktree, {
        command: params.command,
        startupCommandDelivery: params.startupCommandDelivery,
        env: params.env,
        ...(params.launchConfig ? { launchConfig: params.launchConfig } : {}),
        ...(params.launchToken ? { launchToken: params.launchToken } : {}),
        ...(params.launchAgent ? { launchAgent: params.launchAgent } : {}),
        title: params.title,
        focus: params.focus === true,
        rendererBacked: params.rendererBacked === true,
        activate: params.activate === true,
        presentation: params.presentation,
        tabId: params.tabId,
        leafId: params.leafId
      })
    })
  }),
  defineMethod({
    name: 'terminal.split',
    params: TerminalSplit,
    handler: async (params, { runtime }) => ({
      split: await runtime.splitTerminal(params.terminal, {
        direction: params.direction,
        command: params.command,
        env: params.env,
        telemetrySource: params.telemetrySource
      })
    })
  }),
  defineMethod({
    name: 'terminal.stop',
    params: TerminalStop,
    handler: async (params, { runtime }) => runtime.stopTerminalsForWorktree(params.worktree)
  }),
  defineMethod({
    name: 'terminal.stopExact',
    params: TerminalStopExact,
    handler: async (params, { runtime }) =>
      runtime.stopExactTerminalsForWorktree(params.worktree, params.expectedPtyIds, {
        keepHistory: params.keepHistory,
        targetOnly: params.targetOnly
      })
  }),
  defineMethod({
    name: 'terminal.resizeForClient',
    params: TerminalResizeForClient,
    handler: async (params, { runtime }) => {
      // Why: guarded resolution — a stale handle (pane's PTY replaced under it)
      // must fail with terminal_handle_stale instead of resizing the wrong PTY
      // (#7718). Clients recover by re-deriving the handle.
      const leaf = runtime.resolveLiveLeafForHandle(params.terminal)
      if (!leaf?.ptyId) {
        throw new Error('no_connected_pty')
      }
      const result = await runtime.resizeForClient(
        leaf.ptyId,
        params.mode,
        params.clientId,
        params.mode === 'mobile-fit' ? params.cols : undefined,
        params.mode === 'mobile-fit' ? params.rows : undefined
      )
      return {
        terminal: {
          handle: params.terminal,
          ...result
        }
      }
    }
  }),
  defineMethod({
    name: 'terminal.focus',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      focus: await runtime.focusTerminal(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.close',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      close: await runtime.closeTerminal(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.closeTab',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      close: await runtime.closeTerminalTab(params.terminal)
    })
  }),
  defineMethod({
    name: 'agentTeams.tmuxCompat',
    params: AgentTeamsTmuxCompat,
    handler: async (params, { runtime }) => ({
      tmux: await runtime.handleAgentTeamsTmuxCompat(params)
    })
  }),
  defineMethod({
    name: 'agentTeams.prepareLaunch',
    params: AgentTeamsPrepareLaunch,
    handler: async (params, { runtime }) => ({
      launch: await runtime.prepareClaudeAgentTeamsLeader({
        paneKey: params.paneKey,
        baseEnv: params.env
      })
    })
  }),
  defineMethod({
    name: 'terminal.setDisplayMode',
    params: TerminalSetDisplayMode,
    handler: async (params, { runtime }) => {
      // Why: guarded resolution — a stale handle must fail with
      // terminal_handle_stale instead of mutating the wrong PTY's display
      // mode/viewport (#7718). Clients recover by re-deriving the handle.
      const leaf = runtime.resolveLiveLeafForHandle(params.terminal)
      if (!leaf?.ptyId) {
        throw new Error('no_connected_pty')
      }
      // Why: late-bind viewport for callers that subscribed in desktop
      // mode (no viewport stored). Without this, a 'auto' toggle on a
      // viewport-less record skips phone-fit and the user sees no resize.
      if (params.viewport && params.client?.id) {
        runtime.updateMobileSubscriberViewport(leaf.ptyId, params.client.id, params.viewport)
      }
      if (params.client && params.client.type === 'mobile' && params.mode !== 'desktop') {
        runtime.markMobileActor(leaf.ptyId, params.client.id)
      }
      runtime.setMobileDisplayMode(leaf.ptyId, params.mode)
      await runtime.applyMobileDisplayMode(leaf.ptyId)
      return { mode: params.mode, seq: runtime.getLayout(leaf.ptyId)?.seq }
    }
  }),
  defineMethod({
    name: 'terminal.restoreFit',
    params: TerminalHandle,
    handler: async (params, { runtime }) => {
      // Why: guarded resolution — a stale handle must fail with
      // terminal_handle_stale instead of reclaiming the wrong PTY back to
      // desktop dims (#7718). Clients recover by re-deriving the handle.
      const leaf = runtime.resolveLiveLeafForHandle(params.terminal)
      if (!leaf?.ptyId) {
        throw new Error('no_connected_pty')
      }
      return { restored: await runtime.reclaimTerminalForDesktop(leaf.ptyId) }
    }
  }),
  defineMethod({
    name: 'terminal.getDisplayMode',
    params: TerminalHandle,
    handler: async (params, { runtime }) => {
      const leaf = runtime.resolveLeafForHandle(params.terminal)
      const mode = leaf?.ptyId ? runtime.getMobileDisplayMode(leaf.ptyId) : 'auto'
      const isPhoneFitted = leaf?.ptyId ? runtime.isMobileSubscriberActive(leaf.ptyId) : false
      return { mode, isPhoneFitted }
    }
  }),
  defineMethod({
    name: 'terminal.updateViewport',
    params: TerminalUpdateViewport,
    handler: async (params, { runtime }) => {
      // Why: guarded resolution — a stale handle must fail with
      // terminal_handle_stale instead of writing viewport state to the wrong
      // PTY (#7718). Clients recover by re-deriving the handle.
      const leaf = runtime.resolveLiveLeafForHandle(params.terminal)
      if (!leaf?.ptyId) {
        throw new Error('no_connected_pty')
      }
      const viewportUpdate = await updateViewportForClient(
        runtime,
        leaf.ptyId,
        `viewport:${params.client.id}`,
        params.client,
        params.viewport,
        'mobile',
        // Why: one-shot RPC with no disconnect hook — refresh the client's
        // existing stream-owned floor only, never create a leak-prone one.
        'refresh',
        params.claim === true
      )
      return { ...viewportUpdate, seq: runtime.getLayout(leaf.ptyId)?.seq }
    }
  }),
  // Why: desktop remote sessions can have dozens of panes. One streaming RPC
  // owns the binary socket and routes terminal slots by streamId while keeping
  // legacy subscribe as the compatibility fallback.
  defineStreamingMethod({
    name: 'terminal.multiplex',
    params: TerminalMultiplex,
    handler: async (
      _params,
      { runtime, connectionId, sendBinary, registerBinaryStreamHandler, signal },
      emit
    ) => {
      if (!sendBinary || !registerBinaryStreamHandler || !connectionId) {
        throw new Error('binary_terminal_stream_required')
      }

      let closed = false
      let cursor = 0
      const streams = new Map<number, TerminalMultiplexStream>()
      const pendingPtyWaitControllers = new Map<number, Set<AbortController>>()
      let ackTotalInFlightBytes = 0
      let resolveMultiplex = (): void => {}
      const multiplexClosed = new Promise<void>((resolve) => {
        resolveMultiplex = resolve
      })
      const sendFrame = (
        streamId: number,
        opcode: TerminalStreamOpcode,
        payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
        seq?: number
      ): boolean => {
        if (closed) {
          return false
        }
        // Why: Output `seq` is a UTF-16 high-water the client uses for frame-drop
        // gap detection, so a seq-less Output chunk must carry the sentinel 0
        // (== "no seq") rather than the cursor value that orders control frames;
        // a cursor value would poison the client's expected-seq tracker.
        const resolvedSeq =
          typeof seq === 'number' ? seq : opcode === TerminalStreamOpcode.Output ? 0 : cursor++
        const sent = sendBinary(
          encodeTerminalStreamFrame({ opcode, streamId, seq: resolvedSeq, payload })
        )
        return sent !== false
      }
      const sendStreamError = (streamId: number, message: string): void => {
        sendFrame(streamId, TerminalStreamOpcode.Error, encodeTerminalStreamText(message))
        emit({ type: 'error', streamId, message })
      }
      const sendResizedFrame = (
        stream: TerminalMultiplexStream,
        event: { cols: number; rows: number; displayMode: string; reason: string; seq?: number }
      ): void => {
        stream.lastResizeCols = event.cols
        sendFrame(
          stream.streamId,
          TerminalStreamOpcode.Resized,
          encodeTerminalStreamJson({
            cols: event.cols,
            rows: event.rows,
            displayMode: event.displayMode,
            reason: event.reason,
            seq: event.seq
          })
        )
      }
      const canSendAckGatedOutput = (stream: TerminalMultiplexStream, bytes: number): boolean => {
        if (!stream.ackOutput) {
          return true
        }
        return (
          stream.ackInFlightBytes + bytes <= TERMINAL_MULTIPLEX_ACK_STREAM_HIGH_WATER_BYTES &&
          ackTotalInFlightBytes + bytes <= TERMINAL_MULTIPLEX_ACK_TOTAL_HIGH_WATER_BYTES
        )
      }
      const sendAckGatedOutput = (
        stream: TerminalMultiplexStream,
        chunk: TerminalOutputFrameChunk
      ): void => {
        sendFrame(
          stream.streamId,
          chunk.opcode ?? TerminalStreamOpcode.Output,
          chunk.bytes,
          chunk.seq
        )
        if (stream.ackOutput) {
          stream.ackInFlightBytes += chunk.bytes.byteLength
          ackTotalInFlightBytes += chunk.bytes.byteLength
        }
      }
      const queueOrSendOutput = (
        stream: TerminalMultiplexStream,
        chunk: TerminalOutputFrameChunk
      ): void => {
        if (closed || streams.get(stream.streamId) !== stream) {
          return
        }
        if (
          stream.ackPendingOutputOverflowed ||
          stream.ackPendingOutput.length > 0 ||
          !canSendAckGatedOutput(stream, chunk.bytes.byteLength)
        ) {
          appendAckPendingOutput(stream, chunk)
          return
        }
        sendAckGatedOutput(stream, chunk)
      }
      const sendAckRecoverySnapshot = async (stream: TerminalMultiplexStream): Promise<void> => {
        if (
          closed ||
          streams.get(stream.streamId) !== stream ||
          stream.ackRecoverySnapshotInFlight
        ) {
          return
        }
        stream.ackRecoverySnapshotInFlight = true
        try {
          const serialized = await serializeBudgetedRequestedSnapshot(runtime, stream.ptyId, 0)
          if (closed || streams.get(stream.streamId) !== stream) {
            return
          }
          const size = runtime.getTerminalSize(stream.ptyId)
          const displayMode = runtime.getMobileDisplayMode(stream.ptyId)
          // Why: dropped ACK-pending output means live frames are no longer a
          // complete replay. Send a fresh model snapshot before resuming output.
          // Why: truncated marks an unusable snapshot, and clients discard
          // those. The recovery snapshot must be applied to cover dropped
          // output, so it is only truncated when serialization failed.
          sendSnapshotFrames((opcode, payload) => sendFrame(stream.streamId, opcode, payload), {
            kind: 'scrollback',
            cols: serialized?.cols ?? size?.cols ?? 80,
            rows: serialized?.rows ?? size?.rows ?? 24,
            displayMode,
            reason: 'ack-pending-overflow',
            seq: serialized?.seq,
            source: serialized?.source,
            truncated: !serialized,
            truncatedByByteBudget: serialized?.truncatedByByteBudget,
            data: serialized?.data ?? ''
          })
          if (serialized && typeof serialized.seq === 'number') {
            // Why: retained chunks queued before the snapshot serialized are
            // already contained in it; replaying them would duplicate output.
            const snapshotSeq = serialized.seq
            const retained = stream.ackPendingOutput.filter(
              (chunk) => !(typeof chunk.seq === 'number' && chunk.seq <= snapshotSeq)
            )
            stream.ackPendingOutput = retained
            stream.ackPendingOutputBytes = retained.reduce(
              (total, chunk) => total + chunk.bytes.byteLength,
              0
            )
          }
          stream.ackPendingOutputOverflowed = false
        } catch (error) {
          sendStreamError(
            stream.streamId,
            error instanceof Error ? error.message : 'Remote terminal recovery snapshot failed.'
          )
        } finally {
          if (streams.get(stream.streamId) === stream) {
            stream.ackRecoverySnapshotInFlight = false
            flushAckPendingOutput(stream)
          }
        }
      }
      const flushAckPendingOutput = (stream: TerminalMultiplexStream): void => {
        if (stream.ackPendingOutputOverflowed) {
          void sendAckRecoverySnapshot(stream)
          return
        }
        let flushed = 0
        while (
          flushed < stream.ackPendingOutput.length &&
          canSendAckGatedOutput(stream, stream.ackPendingOutput[flushed]!.bytes.byteLength)
        ) {
          sendAckGatedOutput(stream, stream.ackPendingOutput[flushed]!)
          flushed += 1
        }
        if (flushed > 0) {
          stream.ackPendingOutput.splice(0, flushed)
          stream.ackPendingOutputBytes = stream.ackPendingOutput.reduce(
            (total, pending) => total + pending.bytes.byteLength,
            0
          )
        }
      }
      const flushAllAckPendingOutput = (): void => {
        for (const stream of streams.values()) {
          flushAckPendingOutput(stream)
        }
      }
      const acknowledgeOutput = (stream: TerminalMultiplexStream, bytes: number): void => {
        if (!stream.ackOutput || bytes <= 0) {
          return
        }
        const acknowledged = Math.min(stream.ackInFlightBytes, bytes)
        stream.ackInFlightBytes -= acknowledged
        ackTotalInFlightBytes = Math.max(0, ackTotalInFlightBytes - acknowledged)
        flushAllAckPendingOutput()
      }
      const detachStream = (
        streamId: number,
        emitEnd: boolean,
        releaseRemoteDesktopDriver = true
      ): void => {
        const stream = streams.get(streamId)
        if (!stream) {
          return
        }
        stream.outputBatcher.flush()
        stream.outputBatcher.dispose()
        ackTotalInFlightBytes = Math.max(0, ackTotalInFlightBytes - stream.ackInFlightBytes)
        stream.ackInFlightBytes = 0
        stream.ackPendingOutput = []
        stream.ackPendingOutputBytes = 0
        stream.ackPendingOutputOverflowed = false
        stream.ackRecoverySnapshotInFlight = false
        stream.unsubscribeData()
        stream.unsubscribeResize()
        stream.unsubscribeFit()
        stream.unsubscribeDriver()
        stream.unregisterBinaryHandler()
        streams.delete(streamId)
        flushAllAckPendingOutput()
        // Why: release the runtime exit-waiter for this slot (see the field's
        // note). The .catch below no-ops because the stream is already deleted.
        stream.exitWaiterAbort.abort()
        if (stream.isMobile && stream.client?.id) {
          runtime.handleMobileUnsubscribe(stream.ptyId, stream.client.id)
        } else if (
          releaseRemoteDesktopDriver &&
          stream.registeredRemoteDesktopDriver &&
          stream.client?.id
        ) {
          // Why: release the remote-desktop width floor so the host can reclaim
          // its own width once the last remote viewer leaves — but only if THIS
          // stream took it (a passive stream must not release a peer's floor).
          runtime.unregisterRemoteDesktopViewer(stream.ptyId, stream.remoteDesktopSubscriptionKey)
        }
        if (emitEnd) {
          emit({ type: 'end', streamId })
        }
      }
      const cancelPendingPtyWaits = (streamId: number): void => {
        const controllers = pendingPtyWaitControllers.get(streamId)
        if (!controllers) {
          return
        }
        pendingPtyWaitControllers.delete(streamId)
        for (const controller of controllers) {
          controller.abort()
        }
      }
      const cancelAllPendingPtyWaits = (): void => {
        for (const streamId of Array.from(pendingPtyWaitControllers.keys())) {
          cancelPendingPtyWaits(streamId)
        }
      }
      const closeMultiplex = (): void => {
        if (closed) {
          return
        }
        closed = true
        signal?.removeEventListener('abort', cancelAllPendingPtyWaits)
        cancelAllPendingPtyWaits()
        const remoteDesktopKeysByPty = new Map<string, string[]>()
        for (const streamId of Array.from(streams.keys())) {
          const stream = streams.get(streamId)
          if (stream?.registeredRemoteDesktopDriver && !stream.isMobile && stream.client?.id) {
            const keys = remoteDesktopKeysByPty.get(stream.ptyId) ?? []
            keys.push(stream.remoteDesktopSubscriptionKey)
            remoteDesktopKeysByPty.set(stream.ptyId, keys)
          }
          detachStream(streamId, false, false)
        }
        // Why: one connection can own many panes backed by the same PTY.
        // Remove those floors together so close scans each PTY registry once.
        for (const [ptyId, subscriptionKeys] of remoteDesktopKeysByPty) {
          void runtime.unregisterRemoteDesktopViewers(ptyId, subscriptionKeys)
        }
        unregisterControlHandler()
        resolveMultiplex()
      }
      const handleSlotFrame = (
        stream: TerminalMultiplexStream,
        frame: TerminalStreamFrame
      ): void => {
        if (closed || streams.get(stream.streamId) !== stream) {
          return
        }
        if (frame.opcode === TerminalStreamOpcode.Unsubscribe) {
          cancelPendingPtyWaits(stream.streamId)
          detachStream(stream.streamId, false)
          return
        }
        if (frame.opcode === TerminalStreamOpcode.Ack) {
          const parsed = TerminalMultiplexAckFrame.safeParse(
            decodeTerminalStreamJson<unknown>(frame.payload) ?? {}
          )
          if (parsed.success) {
            acknowledgeOutput(stream, parsed.data.bytes)
          }
          return
        }
        if (frame.opcode === TerminalStreamOpcode.Input) {
          const text = decodeTerminalStreamText(frame.payload)
          if (!text) {
            return
          }
          if (isTerminalInputLockedForClient(runtime, stream.ptyId, stream.client)) {
            return
          }
          // Mobile already has the higher-priority floor; a rejected desktop
          // viewport claim must never suppress later phone input.
          const inputClaimTail = stream.isMobile ? Promise.resolve(true) : stream.desktopClaimTail
          void inputClaimTail.then((claimed) => {
            if (!claimed || isTerminalInputLockedForClient(runtime, stream.ptyId, stream.client)) {
              return
            }
            return sendTerminalStreamInput(runtime, {
              terminal: stream.terminal,
              text,
              client: stream.client,
              isMobile: stream.isMobile
            })
          })
          return
        }
        if (frame.opcode === TerminalStreamOpcode.Resize && stream.client) {
          const viewport = decodeTerminalStreamJson<{ cols?: unknown; rows?: unknown }>(
            frame.payload
          )
          if (!viewport || typeof viewport.cols !== 'number' || typeof viewport.rows !== 'number') {
            return
          }
          const cols = viewport.cols
          const rows = viewport.rows
          // Why: resize registers stream-scoped geometry so detach can release
          // it. Older clients lack explicit claims, so Resize remains control.
          if (!stream.isMobile && stream.client?.id) {
            stream.registeredRemoteDesktopDriver = true
            if (stream.buffering) {
              stream.pendingRemoteDesktopViewport = { cols: viewport.cols, rows: viewport.rows }
              return
            }
          }
          stream.desktopClaimTail = stream.desktopClaimTail
            .then(async (priorClaimed) => {
              const result = await updateViewportForClient(
                runtime,
                stream.ptyId,
                stream.remoteDesktopSubscriptionKey,
                stream.client!,
                { cols, rows },
                stream.isMobile ? 'mobile' : 'desktop',
                'register',
                !stream.supportsDesktopViewportClaims
              )
              return stream.supportsDesktopViewportClaims
                ? priorClaimed && result.applied
                : result.applied
            })
            .catch(() => false)
          return
        }
        if (
          frame.opcode === TerminalStreamOpcode.ClaimViewport &&
          stream.client &&
          !stream.isMobile
        ) {
          const viewport = decodeTerminalStreamJson<{ cols?: unknown; rows?: unknown }>(
            frame.payload
          )
          if (!viewport || typeof viewport.cols !== 'number' || typeof viewport.rows !== 'number') {
            return
          }
          const cols = viewport.cols
          const rows = viewport.rows
          stream.registeredRemoteDesktopDriver = true
          stream.desktopClaimTail = stream.desktopClaimTail
            .then(
              () =>
                runtime.updateRemoteDesktopViewer(
                  stream.ptyId,
                  stream.remoteDesktopSubscriptionKey,
                  stream.client!.id,
                  cols,
                  rows,
                  true
                ),
              () =>
                runtime.updateRemoteDesktopViewer(
                  stream.ptyId,
                  stream.remoteDesktopSubscriptionKey,
                  stream.client!.id,
                  cols,
                  rows,
                  true
                )
            )
            .catch(() => false)
          return
        }
        if (frame.opcode === TerminalStreamOpcode.SnapshotRequest) {
          const payload = TerminalMultiplexSnapshotRequestFrame.safeParse(
            decodeTerminalStreamJson<unknown>(frame.payload) ?? {}
          )
          void sendRequestedSnapshot(stream, payload.success ? payload.data : {})
        }
      }
      const sendRequestedSnapshot = async (
        stream: TerminalMultiplexStream,
        request: z.infer<typeof TerminalMultiplexSnapshotRequestFrame>
      ): Promise<void> => {
        if (closed || streams.get(stream.streamId) !== stream) {
          return
        }
        stream.outputBatcher.flush()
        stream.pendingOutputOverflowed = false
        stream.buffering = true
        const requestId = request.requestId
        try {
          const scrollbackRows = normalizeMultiplexSnapshotScrollbackRows(request.scrollbackRows)
          let serialized = await serializeBudgetedRequestedSnapshot(
            runtime,
            stream.ptyId,
            scrollbackRows
          )
          if (closed || streams.get(stream.streamId) !== stream) {
            return
          }
          let size = runtime.getTerminalSize(stream.ptyId)
          let displayMode = runtime.getMobileDisplayMode(stream.ptyId)
          if (stream.pendingOutputOverflowed) {
            // Why: the overflowed tail is newer than the first snapshot. Retry
            // so hidden restore receives a current terminal image instead of null.
            stream.pendingOutput.splice(0)
            stream.pendingOutputBytes = 0
            stream.pendingOutputOverflowed = false
            serialized = await serializeBudgetedRequestedSnapshot(
              runtime,
              stream.ptyId,
              scrollbackRows
            )
            if (closed || streams.get(stream.streamId) !== stream) {
              return
            }
            size = runtime.getTerminalSize(stream.ptyId)
            displayMode = runtime.getMobileDisplayMode(stream.ptyId)
            if (stream.pendingOutputOverflowed) {
              sendSnapshotFrames((opcode, payload) => sendFrame(stream.streamId, opcode, payload), {
                kind: 'scrollback',
                cols: size?.cols ?? 80,
                rows: size?.rows ?? 24,
                requestId,
                displayMode,
                truncated: true,
                truncatedByByteBudget: false,
                data: ''
              })
              return
            }
          }
          sendSnapshotFrames((opcode, payload) => sendFrame(stream.streamId, opcode, payload), {
            kind: 'scrollback',
            cols: serialized?.cols ?? size?.cols ?? 80,
            rows: serialized?.rows ?? size?.rows ?? 24,
            requestId,
            displayMode,
            seq: serialized?.seq,
            cwd: serialized?.cwd,
            source: serialized?.source,
            oscLinks: serialized?.oscLinks,
            pendingEscapeTailAnsi: serialized?.pendingEscapeTailAnsi,
            truncated: false,
            truncatedByByteBudget: serialized?.truncatedByByteBudget,
            data: serialized?.data ?? ''
          })
        } catch (error) {
          sendStreamError(
            stream.streamId,
            error instanceof Error ? error.message : 'Remote terminal snapshot failed.'
          )
        } finally {
          if (streams.get(stream.streamId) === stream) {
            const shouldFlushPendingOutput = !stream.pendingOutputOverflowed
            stream.buffering = false
            const pendingOutput = stream.pendingOutput.splice(0)
            if (shouldFlushPendingOutput) {
              for (const chunk of pendingOutput) {
                stream.outputBatcher.push(chunk.data, chunk.meta)
              }
            }
            stream.pendingOutputBytes = 0
            stream.pendingOutputOverflowed = false
            stream.outputBatcher.flush()
            // Why: a viewer resize that arrived during the snapshot buffering
            // window is parked in pendingRemoteDesktopViewport; apply it now or
            // it is silently dropped until the viewer's next resize.
            if (
              !stream.isMobile &&
              stream.client?.id &&
              stream.registeredRemoteDesktopDriver &&
              stream.pendingRemoteDesktopViewport
            ) {
              const viewport = stream.pendingRemoteDesktopViewport
              stream.pendingRemoteDesktopViewport = null
              void updateViewportForClient(
                runtime,
                stream.ptyId,
                stream.remoteDesktopSubscriptionKey,
                stream.client,
                viewport,
                'desktop',
                'register',
                !stream.supportsDesktopViewportClaims
              ).catch(() => {})
            }
          }
        }
      }
      const handleSubscribeFrame = async (payload: Uint8Array<ArrayBufferLike>): Promise<void> => {
        const raw = decodeTerminalStreamJson<unknown>(payload)
        const parsed = TerminalMultiplexSubscribeFrame.safeParse(raw)
        if (!parsed.success) {
          return
        }
        const request = parsed.data
        detachStream(request.streamId, false)

        const isMobile = request.client?.type === 'mobile'
        let leaf: { ptyId: string | null } | null
        try {
          // Why: guarded resolution — binding the output stream to whatever
          // PTY now occupies a stale handle's pane silently mirrors the wrong
          // terminal after a reconnect (#7718). terminal_handle_stale lets the
          // client re-derive the handle from the current session snapshot.
          leaf = runtime.resolveLiveLeafForHandle(request.terminal)
        } catch {
          sendStreamError(request.streamId, 'terminal_handle_stale')
          emit({ type: 'end', streamId: request.streamId })
          return
        }
        if (!leaf?.ptyId && request.client) {
          // Why: a never-mounted tab has no graph leaf to await; mounting the
          // exact tab lets its PTY attach without activating the worktree.
          runtime.requestRendererTerminalTabMount(request.terminal)
          const waitController = new AbortController()
          const pendingControllers = pendingPtyWaitControllers.get(request.streamId) ?? new Set()
          pendingControllers.add(waitController)
          pendingPtyWaitControllers.set(request.streamId, pendingControllers)
          if (signal?.aborted) {
            waitController.abort()
          }
          // Why: the live slot handler does not exist until the PTY attaches;
          // retain cancellation ownership while the pane is still pending.
          const unregisterPendingHandler = registerBinaryStreamHandler(
            request.streamId,
            (frame) => {
              if (frame.opcode === TerminalStreamOpcode.Unsubscribe) {
                cancelPendingPtyWaits(request.streamId)
                detachStream(request.streamId, false)
              }
            }
          )
          try {
            const ptyId = await runtime.waitForLeafPtyId(
              request.terminal,
              10_000,
              waitController.signal
            )
            leaf = { ptyId }
          } catch {
            if (closed || signal?.aborted || waitController.signal.aborted) {
              return
            }
            // Fall through to the explicit no_connected_pty error below.
          } finally {
            const currentControllers = pendingPtyWaitControllers.get(request.streamId)
            currentControllers?.delete(waitController)
            if (currentControllers?.size === 0) {
              pendingPtyWaitControllers.delete(request.streamId)
            }
            unregisterPendingHandler()
          }
        }
        if (!leaf?.ptyId) {
          sendStreamError(request.streamId, 'no_connected_pty')
          emit({ type: 'end', streamId: request.streamId })
          return
        }
        if (closed) {
          return
        }
        // Why: a competing subscribe for the same streamId can fully register
        // while this one awaited the PTY id above. Overwriting it in
        // `streams` would orphan its data/view-subscriber registrations — a
        // leaked view subscriber permanently silences the model query
        // responder (terminal-query-authority.md). Detach it so every
        // registration stays release-balanced.
        detachStream(request.streamId, false)

        const ptyId = leaf.ptyId
        const stream: TerminalMultiplexStream = {
          streamId: request.streamId,
          terminal: request.terminal,
          ptyId,
          client: request.client,
          isMobile,
          ackOutput: request.capabilities?.ackOutput === 1,
          ackInFlightBytes: 0,
          supportsDesktopViewportClaims: request.capabilities?.desktopViewportClaims === 1,
          desktopClaimTail: Promise.resolve(true),
          registeredRemoteDesktopDriver: false,
          // Why: streamId is client-local, so two remote connections can both
          // use stream 1 for the same PTY. Scope the width-floor key by
          // connectionId (guaranteed present above) so they can't
          // overwrite/release each other's floor.
          remoteDesktopSubscriptionKey: `multiplex:${connectionId}:${request.streamId}`,
          pendingRemoteDesktopViewport: null,
          buffering: true,
          ackPendingOutput: [],
          ackPendingOutputBytes: 0,
          ackPendingOutputOverflowed: false,
          ackRecoverySnapshotInFlight: false,
          pendingOutput: [],
          pendingOutputBytes: 0,
          pendingOutputOverflowed: false,
          lastResizeCols: undefined,
          resizeGeneration: 0,
          outputBatcher: createTerminalOutputBatcher((data, meta) => {
            if (meta?.cwd !== undefined) {
              sendFrame(
                request.streamId,
                TerminalStreamOpcode.Metadata,
                encodeTerminalStreamJson({ cwd: meta.cwd }),
                meta.seq
              )
            }
            for (const chunk of iterateTerminalOutputFrameChunks(data, meta)) {
              queueOrSendOutput(stream, chunk)
            }
          }),
          unsubscribeData: () => {},
          unsubscribeResize: () => {},
          unsubscribeFit: () => {},
          unsubscribeDriver: () => {},
          unregisterBinaryHandler: () => {},
          exitWaiterAbort: new AbortController()
        }
        streams.set(request.streamId, stream)
        stream.unregisterBinaryHandler = registerBinaryStreamHandler(request.streamId, (frame) =>
          handleSlotFrame(stream, frame)
        )

        try {
          const unsubscribeStreamData = runtime.subscribeToTerminalData(ptyId, (data, meta) => {
            if (closed || streams.get(request.streamId) !== stream) {
              return
            }
            if (stream.buffering) {
              appendPendingMultiplexOutput(stream, data, meta)
              return
            }
            stream.outputBatcher.push(data, meta)
          })
          // Why: a multiplexed stream feeds a remote xterm view that answers
          // terminal queries with view authority; the main model responder
          // yields while it is attached (terminal-query-authority.md).
          // Wrapped into unsubscribeData so every detach path releases it.
          const releaseViewSubscriber = runtime.registerRemoteTerminalViewSubscriber(ptyId)
          stream.unsubscribeData = () => {
            releaseViewSubscriber()
            unsubscribeStreamData()
          }

          if (isMobile && request.client?.id) {
            await runtime.handleMobileSubscribe(ptyId, request.client.id, request.viewport)
          } else if (request.client?.id && request.viewport) {
            // Why: subscribe records this stream's geometry and cleanup key,
            // but does not claim ownership. Activity frames claim later.
            stream.registeredRemoteDesktopDriver = true
            stream.pendingRemoteDesktopViewport = request.viewport
          }
          if (
            !isMobile &&
            request.client?.id &&
            stream.registeredRemoteDesktopDriver &&
            stream.pendingRemoteDesktopViewport
          ) {
            const viewport = stream.pendingRemoteDesktopViewport
            stream.pendingRemoteDesktopViewport = null
            await updateViewportForClient(
              runtime,
              ptyId,
              stream.remoteDesktopSubscriptionKey,
              request.client,
              viewport,
              'desktop',
              'register',
              !stream.supportsDesktopViewportClaims
            )
          }
          if (closed || streams.get(request.streamId) !== stream) {
            return
          }

          let read = await runtime.readTerminal(request.terminal)
          let serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, isMobile)
          if (closed || streams.get(request.streamId) !== stream) {
            return
          }
          let initialOutputOverflowed = false
          if (stream.pendingOutputOverflowed) {
            stream.pendingOutput.splice(0)
            stream.pendingOutputBytes = 0
            stream.pendingOutputOverflowed = false
            read = await runtime.readTerminal(request.terminal)
            serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, isMobile)
            if (closed || streams.get(request.streamId) !== stream) {
              return
            }
            if (stream.pendingOutputOverflowed) {
              initialOutputOverflowed = true
              stream.pendingOutput.splice(0)
              stream.pendingOutputBytes = 0
              stream.pendingOutputOverflowed = false
            }
          }
          const size = runtime.getTerminalSize(ptyId)
          const displayMode = runtime.getMobileDisplayMode(ptyId)
          const layoutSeq = runtime.getLayout(ptyId)?.seq
          const snapshotFrameSeq = serialized?.seq ?? layoutSeq
          const snapshotOutputSeq = serialized?.seq
          emit({
            type: 'subscribed',
            streamId: request.streamId,
            terminal: request.terminal,
            cols: serialized?.cols ?? size?.cols,
            rows: serialized?.rows ?? size?.rows,
            displayMode,
            seq: layoutSeq,
            truncated:
              initialOutputOverflowed ||
              (serialized ? read.truncated : isTerminalReadPayloadIncomplete(read))
          })
          sendSnapshotFrames((opcode, payload) => sendFrame(request.streamId, opcode, payload), {
            kind: 'scrollback',
            cols: serialized?.cols ?? size?.cols ?? 80,
            rows: serialized?.rows ?? size?.rows ?? 24,
            displayMode,
            seq: snapshotFrameSeq,
            cwd: serialized?.cwd,
            truncated:
              initialOutputOverflowed ||
              (serialized ? read.truncated : isTerminalReadPayloadIncomplete(read)),
            truncatedByByteBudget: serialized?.truncatedByByteBudget,
            source: serialized?.source,
            oscLinks: serialized?.oscLinks,
            pendingEscapeTailAnsi: serialized?.pendingEscapeTailAnsi,
            data: serialized?.data ?? (read.tail.length > 0 ? `${read.tail.join('\r\n')}\r\n` : '')
          })
          // Why: baseline for resize re-stream gating; the client already
          // rewrapped to these cols via the initial snapshot replay.
          stream.lastResizeCols = serialized?.cols ?? size?.cols
          stream.buffering = false
          const pendingOutput = stream.pendingOutput.splice(0)
          if (!initialOutputOverflowed) {
            for (const chunk of pendingOutput) {
              const uncoveredData = getOutputAfterSnapshotSeq(chunk, snapshotOutputSeq)
              if (uncoveredData) {
                stream.outputBatcher.push(uncoveredData, chunk.meta)
              }
            }
          }
          stream.pendingOutputBytes = 0
          stream.pendingOutputOverflowed = false
          stream.outputBatcher.flush()
          if (!isMobile) {
            stream.unsubscribeFit = runtime.subscribeToFitOverrideChanges(ptyId, (event) => {
              const mode =
                event.mode === 'mobile-fit'
                  ? event.mode
                  : (runtime.getRemoteDesktopFitHold?.(ptyId, stream.remoteDesktopSubscriptionKey)
                      .mode ?? 'desktop-fit')
              emit({
                type: 'fit-override-changed',
                streamId: request.streamId,
                mode,
                cols: event.cols,
                rows: event.rows
              })
            })
            stream.unsubscribeDriver = runtime.subscribeToDriverChanges(ptyId, (driver) => {
              emit({
                type: 'driver-changed',
                streamId: request.streamId,
                driver
              })
            })
            const fitOverride = runtime.getTerminalFitOverride(ptyId)
            const desktopHold = runtime.getRemoteDesktopFitHold?.(
              ptyId,
              stream.remoteDesktopSubscriptionKey
            ) ?? { mode: 'desktop-fit' as const, cols: size?.cols ?? 0, rows: size?.rows ?? 0 }
            emit({
              type: 'fit-override-changed',
              streamId: request.streamId,
              mode: fitOverride?.mode ?? desktopHold.mode,
              cols: fitOverride?.cols ?? desktopHold.cols,
              rows: fitOverride?.rows ?? desktopHold.rows
            })
            emit({
              type: 'driver-changed',
              streamId: request.streamId,
              driver: runtime.getDriver(ptyId)
            })
          }
          stream.unsubscribeResize = runtime.subscribeToTerminalResize(ptyId, (event) => {
            stream.outputBatcher.flush()
            const resizeGeneration = stream.resizeGeneration + 1
            stream.resizeGeneration = resizeGeneration
            const widthChanged = stream.isMobile && event.cols !== stream.lastResizeCols
            if (widthChanged) {
              stream.lastResizeCols = event.cols
              // Why: re-serialize+replay the full scrollback at the new cols so
              // restored hard-wrapped lines rewrap; the await means later live
              // output still flows on this stream after the snapshot lands.
              void sendMobileResizeRestream(
                runtime,
                ptyId,
                (opcode, payload) => sendFrame(request.streamId, opcode, payload),
                event,
                () =>
                  !closed &&
                  streams.get(request.streamId) === stream &&
                  stream.resizeGeneration === resizeGeneration
              )
                .then((restreamed) => {
                  if (
                    closed ||
                    streams.get(request.streamId) !== stream ||
                    stream.resizeGeneration !== resizeGeneration
                  ) {
                    return
                  }
                  if (!restreamed) {
                    sendResizedFrame(stream, event)
                  }
                })
                // Why: if re-stream serialization/runtime throws, still emit the
                // geometry-only Resized frame so the client never misses the resize.
                .catch(() => {
                  if (
                    closed ||
                    streams.get(request.streamId) !== stream ||
                    stream.resizeGeneration !== resizeGeneration
                  ) {
                    return
                  }
                  sendResizedFrame(stream, event)
                })
              return
            }
            sendResizedFrame(stream, event)
          })
          // Install the resize listener before draining the parked viewport;
          // applyLayout emits synchronously and the stream must observe it.
          if (
            !stream.isMobile &&
            stream.client?.id &&
            stream.registeredRemoteDesktopDriver &&
            stream.pendingRemoteDesktopViewport
          ) {
            const viewport = stream.pendingRemoteDesktopViewport
            stream.pendingRemoteDesktopViewport = null
            void updateViewportForClient(
              runtime,
              ptyId,
              stream.remoteDesktopSubscriptionKey,
              stream.client,
              viewport,
              'desktop',
              'register',
              !stream.supportsDesktopViewportClaims
            ).catch(() => {})
          }
          void runtime
            .waitForTerminal(request.terminal, {
              condition: 'exit',
              signal: stream.exitWaiterAbort.signal
            })
            .then(() => {
              if (streams.get(request.streamId) === stream) {
                detachStream(request.streamId, true)
              }
            })
            .catch(() => {
              if (streams.get(request.streamId) === stream) {
                detachStream(request.streamId, true)
              }
            })
        } catch (error) {
          // Why the ownership check: a newer subscribe may own this streamId
          // now (it detached and released this stream on arrival). Detaching
          // or erroring the slot here would tear down the successor's live
          // registrations instead of this stream's.
          if (streams.get(request.streamId) !== stream) {
            return
          }
          detachStream(request.streamId, false)
          sendStreamError(request.streamId, error instanceof Error ? error.message : String(error))
          emit({ type: 'end', streamId: request.streamId })
        }
      }
      const unregisterControlHandler = registerBinaryStreamHandler(0, (frame) => {
        if (frame.opcode === TerminalStreamOpcode.Subscribe) {
          void handleSubscribeFrame(frame.payload)
        }
      })

      signal?.addEventListener('abort', cancelAllPendingPtyWaits, { once: true })

      runtime.registerSubscriptionCleanup(
        `terminal-multiplex:${connectionId}`,
        closeMultiplex,
        connectionId
      )
      emit({ type: 'ready' })
      await multiplexClosed
    }
  }),
  // Why: terminal.subscribe streams live terminal output over WebSocket.
  // It sends initial scrollback, then live data chunks as they arrive.
  // Mobile clients pass client+viewport params for server-side auto-fit.
  defineStreamingMethod({
    name: 'terminal.subscribe',
    params: TerminalSubscribe,
    handler: async (
      params,
      { runtime, connectionId, sendBinary, registerBinaryStreamHandler, signal },
      emit
    ) => {
      let leaf = runtime.resolveLeafForHandle(params.terminal)
      const isMobile = params.client?.type === 'mobile'
      const serializerGenerationBeforeAnyMount = isMobile
        ? (runtime.getRendererTerminalSerializerGenerationForHandle?.(params.terminal) ?? 0)
        : 0
      let rendererMountRequestedBeforePty = false
      const useBinaryStream = params.capabilities?.terminalBinaryStream === 1 && Boolean(sendBinary)
      // Why: a closed stream must not allocate listeners, mobile-fit state, or
      // a hidden renderer surface that no client remains to consume.
      if (signal?.aborted) {
        return
      }

      // Why: the left pane's PTY spawns asynchronously after the tab is created.
      // Clients that subscribe before the PTY is ready would get a bare
      // scrollback+end with no live stream or phone-fit. Wait for the PTY so
      // the subscribe can proceed normally.
      if (!leaf?.ptyId && params.client) {
        // Why: a never-mounted tab has no graph leaf to await; mounting the
        // exact tab lets its PTY attach without activating the worktree.
        rendererMountRequestedBeforePty = runtime.requestRendererTerminalTabMount(params.terminal)
        try {
          const ptyId = await runtime.waitForLeafPtyId(params.terminal, 10_000, signal)
          leaf = { ptyId }
        } catch {
          if (signal?.aborted) {
            return
          }
          // PTY wait timed out — fall through to scrollback-only path below
        }
      }

      if (!leaf?.ptyId) {
        const read = await runtime.readTerminal(params.terminal)
        emit({
          type: 'subscribed',
          streamId: null,
          lines: read.tail,
          truncated: isTerminalReadPayloadIncomplete(read)
        })
        emit({ type: 'end' })
        return
      }

      if (isMobile && (!useBinaryStream || !sendBinary)) {
        throw new Error('binary_terminal_stream_required')
      }

      const ptyId = leaf.ptyId
      const clientId = params.client?.id
      const mobileInputLeaseOnly =
        isMobile && params.capabilities?.mobileInputLeaseOnly === 1 && Boolean(clientId)
      // Why: the initial mount/PTY wait and phone-fit can both emit a redraw
      // that creates suffix-only state, so preserve the pre-mount absence signal.
      const missingHeadlessStateBeforeMobileFit =
        isMobile &&
        (rendererMountRequestedBeforePty || runtime.hasHeadlessTerminalState?.(ptyId) === false)
      const serializerGenerationBeforeMobileFit = missingHeadlessStateBeforeMobileFit
        ? rendererMountRequestedBeforePty
          ? serializerGenerationBeforeAnyMount
          : runtime.getRendererTerminalSerializerGeneration(ptyId)
        : 0
      const supportsDesktopViewportClaims = params.capabilities?.desktopViewportClaims === 1
      if (mobileInputLeaseOnly && clientId) {
        let closed = false
        let resolveStream = (): void => {}
        const streamClosed = new Promise<void>((resolve) => {
          resolveStream = resolve
        })
        const subscriptionId = `${params.terminal}:${clientId}`
        // Why: chat needs the input-floor acknowledgement without registering
        // a view subscriber or transporting duplicate PTY output.
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            closed = true
            runtime.handleMobileUnsubscribe(ptyId, clientId)
            emit({ type: 'end' })
            resolveStream()
          },
          connectionId
        )
        void runtime
          .waitForTerminal(params.terminal, { condition: 'exit', signal })
          .then(() => runtime.cleanupSubscription(subscriptionId))
          .catch(() => runtime.cleanupSubscription(subscriptionId))
        try {
          await runtime.handleMobileSubscribe(ptyId, clientId, params.viewport)
          if (closed || signal?.aborted) {
            // Why: a disconnect can win the awaited subscribe and otherwise
            // resurrect mobile presence after cleanup already released it.
            runtime.handleMobileUnsubscribe(ptyId, clientId)
            if (!closed) {
              runtime.cleanupSubscription(subscriptionId)
            }
            return
          }
          emit({ type: 'subscribed', streamId: null, lines: [], truncated: false })
          await streamClosed
        } catch (error) {
          runtime.cleanupSubscription(subscriptionId)
          throw error
        }
        return
      }
      // Why: only unregister the width floor this subscription took (see the
      // multiplex stream's registeredRemoteDesktopDriver note).
      let registeredRemoteDesktopDriver = false
      if (!useBinaryStream) {
        // Why: desktop can have both a hidden automation watcher and a visible
        // pane subscribed to the same terminal. Key by client when provided so
        // one stream cannot evict the other.
        const subscriptionId = clientId ? `${params.terminal}:${clientId}` : params.terminal
        const remoteDesktopSubscriptionKey = `json:${nextTerminalStreamId++}`
        let closed = false
        let outputBatcher: ReturnType<typeof createTerminalOutputBatcher> | null = null
        let unsubscribeData = (): void => {}
        let unsubscribeFit = (): void => {}
        let resolveStream = (): void => {}
        const streamClosed = new Promise<void>((resolve) => {
          resolveStream = resolve
        })
        // Why: register before viewport/snapshot awaits so a socket close cannot
        // orphan either the stream listeners or its remote-desktop width floor.
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            closed = true
            outputBatcher?.flush()
            outputBatcher?.dispose()
            unsubscribeData()
            unsubscribeFit()
            if (registeredRemoteDesktopDriver && clientId) {
              runtime.unregisterRemoteDesktopViewer(ptyId, remoteDesktopSubscriptionKey)
            }
            emit({ type: 'end' })
            resolveStream()
          },
          connectionId
        )
        try {
          if (clientId && params.client && params.viewport) {
            registeredRemoteDesktopDriver = true
            await updateViewportForClient(
              runtime,
              ptyId,
              remoteDesktopSubscriptionKey,
              params.client,
              params.viewport,
              'desktop',
              'register',
              !supportsDesktopViewportClaims
            )
          }
          if (closed || signal?.aborted) {
            runtime.cleanupSubscription(subscriptionId)
            return
          }
          const read = await runtime.readTerminal(params.terminal)
          const serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, false)
          if (closed || signal?.aborted) {
            runtime.cleanupSubscription(subscriptionId)
            return
          }
          const size = runtime.getTerminalSize(ptyId)
          const displayMode = runtime.getMobileDisplayMode(ptyId)
          const seq = runtime.getLayout(ptyId)?.seq
          emit({
            type: 'scrollback',
            lines: read.tail,
            truncated: isTerminalReadPayloadIncomplete(read),
            serialized: serialized?.data,
            oscLinks: serialized?.oscLinks,
            cwd: serialized?.cwd,
            cols: serialized?.cols ?? size?.cols,
            rows: serialized?.rows ?? size?.rows,
            displayMode,
            seq
          })
          outputBatcher = createTerminalOutputBatcher((chunk) => {
            emit({ type: 'data', chunk })
          })
          const unsubscribeStreamData = runtime.subscribeToTerminalData(ptyId, (data) => {
            outputBatcher?.push(data)
          })
          // Why: this legacy JSON stream can feed a live xterm view too
          // (older web/desktop subscribers), so it conservatively registers
          // as a remote view subscriber. For read-only watchers the cost is
          // a withheld model reply — the pre-Phase-5 status quo — which is
          // strictly safer than a double reply under a view consumer.
          const releaseViewSubscriber = runtime.registerRemoteTerminalViewSubscriber(ptyId)
          unsubscribeData = () => {
            releaseViewSubscriber()
            unsubscribeStreamData()
          }
          unsubscribeFit = runtime.subscribeToFitOverrideChanges(ptyId, (event) => {
            outputBatcher?.flush()
            const mode =
              event.mode === 'mobile-fit'
                ? event.mode
                : (runtime.getRemoteDesktopFitHold?.(ptyId, remoteDesktopSubscriptionKey).mode ??
                  'desktop-fit')
            emit({
              type: 'fit-override-changed',
              mode,
              cols: event.cols,
              rows: event.rows
            })
          })
          // Why: bind the exit-waiter to the connection dispatch signal so it is
          // removed on socket close/error instead of leaking until real exit.
          void runtime
            .waitForTerminal(params.terminal, { condition: 'exit', signal })
            .then(() => runtime.cleanupSubscription(subscriptionId))
            .catch(() => runtime.cleanupSubscription(subscriptionId))
          await streamClosed
        } catch (error) {
          runtime.cleanupSubscription(subscriptionId)
          throw error
        }
        return
      }

      const streamId = nextTerminalStreamId++
      const remoteDesktopSubscriptionKey = `stream:${streamId}`
      let cursor = 0
      let closed = false
      let buffering = true
      let pendingRemoteDesktopViewport: { cols: number; rows: number } | null = null
      // Why: the cols the mobile client last rewrapped to; gate the
      // resize re-stream so it only fires on an actual width change.
      let lastResizeCols: number | undefined
      let resizeGeneration = 0
      let pendingOutput: TerminalOutputChunk[] = []
      let desktopClaimTail: Promise<boolean> = Promise.resolve(true)
      let pendingOutputBytes = 0
      let pendingOutputOverflowed = false
      let pendingQueryScanState: TerminalReplyQueryScanState = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
      const pendingQuerySequences: TerminalReplyQuerySequence[] = []
      let pendingQueryChars = 0
      let pendingQueryOverflowed = false
      let unsubscribeData = (): void => {}
      let unsubscribeResize = (): void => {}
      let unsubscribeFit = (): void => {}
      let unregisterBinaryHandler = (): void => {}
      let abortRendererMountWait = (): void => {}
      let lateRendererReadyPromise: Promise<boolean> | null = null
      let outputBatcher: ReturnType<typeof createTerminalOutputBatcher> | null = null
      let resolveStream = (): void => {}
      const streamClosed = new Promise<void>((resolve) => {
        resolveStream = resolve
      })
      // Why: register cleanup before any mobile-fit or snapshot await. A phone
      // can disconnect mid-subscribe; cleanup must still remove mobile
      // presence. Client-scoped ids also allow parallel desktop subscribers.
      const subscriptionId = clientId ? `${params.terminal}:${clientId}` : params.terminal
      runtime.registerSubscriptionCleanup(
        subscriptionId,
        () => {
          outputBatcher?.flush()
          outputBatcher?.dispose()
          closed = true
          unsubscribeData()
          unsubscribeResize()
          unsubscribeFit()
          unregisterBinaryHandler()
          abortRendererMountWait()
          if (isMobile && clientId) {
            runtime.handleMobileUnsubscribe(ptyId, clientId)
          } else if (registeredRemoteDesktopDriver && clientId) {
            runtime.unregisterRemoteDesktopViewer(ptyId, remoteDesktopSubscriptionKey)
          }
          emit({ type: 'end' })
          resolveStream()
        },
        connectionId
      )
      // Why: bind the exit-waiter to the connection dispatch signal so it is
      // removed on socket close/error instead of leaking until real exit.
      void runtime
        .waitForTerminal(params.terminal, { condition: 'exit', signal })
        .then(() => runtime.cleanupSubscription(subscriptionId))
        .catch(() => runtime.cleanupSubscription(subscriptionId))
      const sendFrame = (
        opcode: TerminalStreamOpcode,
        payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
        frameSeq = cursor++
      ): void => {
        if (closed || !sendBinary) {
          return
        }
        sendBinary(encodeTerminalStreamFrame({ opcode, streamId, seq: frameSeq, payload }))
      }
      outputBatcher = createTerminalOutputBatcher((data, meta) => {
        if (meta?.cwd !== undefined) {
          sendFrame(
            TerminalStreamOpcode.Metadata,
            encodeTerminalStreamJson({ cwd: meta.cwd }),
            meta.seq
          )
        }
        for (const chunk of iterateTerminalOutputFrameChunks(data, meta)) {
          sendFrame(chunk.opcode ?? TerminalStreamOpcode.Output, chunk.bytes, chunk.seq)
        }
      })
      unregisterBinaryHandler =
        registerBinaryStreamHandler?.(streamId, (frame) => {
          if (closed) {
            return
          }
          if (frame.opcode === TerminalStreamOpcode.Input) {
            const text = decodeTerminalStreamText(frame.payload)
            if (!text) {
              return
            }
            if (isTerminalInputLockedForClient(runtime, ptyId, params.client)) {
              return
            }
            void desktopClaimTail.then(async (claimed) => {
              if (!claimed || isTerminalInputLockedForClient(runtime, ptyId, params.client)) {
                return
              }
              await sendTerminalStreamInput(runtime, {
                terminal: params.terminal,
                text,
                client: params.client,
                isMobile
              })
            })
            return
          }
          if (frame.opcode === TerminalStreamOpcode.Resize && params.client) {
            const viewport = decodeTerminalStreamJson<{ cols?: unknown; rows?: unknown }>(
              frame.payload
            )
            if (
              !viewport ||
              typeof viewport.cols !== 'number' ||
              typeof viewport.rows !== 'number'
            ) {
              return
            }
            const cols = viewport.cols
            const rows = viewport.rows
            if (clientId) {
              registeredRemoteDesktopDriver = true
              if (buffering) {
                pendingRemoteDesktopViewport = { cols: viewport.cols, rows: viewport.rows }
                return
              }
            }
            desktopClaimTail = desktopClaimTail
              .then(async (priorClaimed) => {
                const result = await updateViewportForClient(
                  runtime,
                  ptyId,
                  remoteDesktopSubscriptionKey,
                  params.client!,
                  { cols, rows },
                  'desktop',
                  'register',
                  !supportsDesktopViewportClaims
                )
                return supportsDesktopViewportClaims
                  ? priorClaimed && result.applied
                  : result.applied
              })
              .catch(() => false)
            return
          }
          if (
            frame.opcode === TerminalStreamOpcode.ClaimViewport &&
            params.client &&
            clientId &&
            !isMobile
          ) {
            const viewport = decodeTerminalStreamJson<{ cols?: unknown; rows?: unknown }>(
              frame.payload
            )
            if (
              !viewport ||
              typeof viewport.cols !== 'number' ||
              typeof viewport.rows !== 'number'
            ) {
              return
            }
            const cols = viewport.cols
            const rows = viewport.rows
            registeredRemoteDesktopDriver = true
            desktopClaimTail = desktopClaimTail
              .then(
                () =>
                  runtime.updateRemoteDesktopViewer(
                    ptyId,
                    remoteDesktopSubscriptionKey,
                    clientId,
                    cols,
                    rows,
                    true
                  ),
                () =>
                  runtime.updateRemoteDesktopViewer(
                    ptyId,
                    remoteDesktopSubscriptionKey,
                    clientId,
                    cols,
                    rows,
                    true
                  )
              )
              .catch(() => false)
          }
        }) ?? (() => {})
      const unsubscribeStreamData = runtime.subscribeToTerminalData(ptyId, (data, meta) => {
        if (closed) {
          return
        }
        if (buffering) {
          const rawLength = meta?.rawLength
          if (
            typeof meta?.seq === 'number' &&
            typeof rawLength === 'number' &&
            rawLength === data.length
          ) {
            const scan = scanTerminalReplyQuerySequences(
              data,
              meta.seq - rawLength,
              pendingQueryScanState
            )
            pendingQueryScanState = scan.state
            for (const query of scan.queries) {
              if (pendingQueryChars + query.data.length > TERMINAL_QUERY_REPLAY_MAX_CHARS) {
                pendingQueryOverflowed = true
                break
              }
              pendingQuerySequences.push(query)
              pendingQueryChars += query.data.length
            }
          } else {
            pendingQueryScanState = EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
          }
          const remainingBudget = Math.max(
            1,
            TERMINAL_MULTIPLEX_PENDING_MAX_BYTES - pendingOutputBytes
          )
          const measurement = measureTerminalStreamByteLength(data, {
            stopAfterBytes: remainingBudget
          })
          pendingOutput.push({ data, bytes: measurement.byteLength, meta })
          pendingOutputBytes += measurement.byteLength
          const trimmed = trimPendingOutputToBudget(pendingOutput, pendingOutputBytes)
          pendingOutputBytes = trimmed.bytes
          pendingOutputOverflowed ||= trimmed.overflowed
          return
        }
        outputBatcher?.push(data, meta)
      })
      // Why: live bytes must be captured before mobile fit awaits. Registering
      // mobile presence first would suppress main while no view held the query.
      const releaseViewSubscriber = runtime.registerRemoteTerminalViewSubscriber(ptyId)
      unsubscribeData = () => {
        releaseViewSubscriber()
        unsubscribeStreamData()
      }
      // Server-side auto-fit: resize PTY to phone dims before serializing scrollback
      try {
        if (isMobile && clientId) {
          await runtime.handleMobileSubscribe(ptyId, clientId, params.viewport)
        } else if (clientId && params.viewport) {
          // Why: legacy subscribe records geometry without taking ownership;
          // only an explicit activity/claim frame may suppress the host.
          registeredRemoteDesktopDriver = true
          pendingRemoteDesktopViewport = params.viewport
        }
        if (closed) {
          return
        }

        let read = await runtime.readTerminal(params.terminal)
        let serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, isMobile)
        if (closed) {
          return
        }
        // Why: missing model state—not snapshot text—is the signal that this
        // PTY may never have attached; avoid remounting legitimate blank panes.
        // A renderer-sourced snapshot also proves the exact pane is already
        // attached, so waiting for a fresh mount generation would only stall.
        const mountRequested =
          missingHeadlessStateBeforeMobileFit &&
          serialized?.source !== 'renderer' &&
          (rendererMountRequestedBeforePty ||
            runtime.requestRendererTerminalTabMount(params.terminal))
        if (missingHeadlessStateBeforeMobileFit && mountRequested) {
          // Why: an idle legacy PTY emits no later byte; a fresh settle proves
          // this exact remount completed before we replay its restored screen.
          const mountWaitController = new AbortController()
          const abortMountWait = (): void => mountWaitController.abort()
          abortRendererMountWait = abortMountWait
          if (signal?.aborted) {
            abortMountWait()
          } else {
            signal?.addEventListener('abort', abortMountWait, { once: true })
          }
          const rendererReadyPromise = runtime
            .waitForRendererTerminalSerializer(
              ptyId,
              serializerGenerationBeforeMobileFit,
              undefined,
              mountWaitController.signal
            )
            .catch(() => false)
          const finishMountWait = (): void => {
            signal?.removeEventListener('abort', abortMountWait)
            if (abortRendererMountWait === abortMountWait) {
              abortRendererMountWait = () => {}
            }
          }
          void rendererReadyPromise.then(finishMountWait, finishMountWait)
          let deadlineTimer: ReturnType<typeof setTimeout> | null = null
          const initialDeadline = new Promise<boolean>((resolve) => {
            deadlineTimer = setTimeout(() => resolve(false), MOBILE_RENDERER_MOUNT_READY_TIMEOUT_MS)
            if (typeof deadlineTimer.unref === 'function') {
              deadlineTimer.unref()
            }
          })
          const rendererReady = await Promise.race([rendererReadyPromise, initialDeadline])
          if (deadlineTimer) {
            clearTimeout(deadlineTimer)
          }
          if (closed || signal?.aborted) {
            return
          }
          if (rendererReady) {
            read = await runtime.readTerminal(params.terminal)
            const stableRendererSnapshot = await serializeStableMobileRendererSnapshot(
              runtime,
              ptyId
            )
            if (closed) {
              return
            }
            if (stableRendererSnapshot?.data.length) {
              serialized = stableRendererSnapshot
              const trailingOutput = pendingOutput.flatMap((item) => {
                const data = getOutputAfterSnapshotSeq(item, stableRendererSnapshot.seq)
                const seq = item.meta?.seq
                return data && typeof seq === 'number' ? [{ data, seq }] : []
              })
              runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(
                ptyId,
                stableRendererSnapshot,
                trailingOutput
              )
            }
          } else {
            // Why: a renderer can settle after the bounded initial response.
            // Keep observing it so an idle PTY still self-heals without bytes.
            lateRendererReadyPromise = rendererReadyPromise
          }
        }
        let initialOutputOverflowed = false
        if (pendingOutputOverflowed) {
          pendingOutput.splice(0)
          pendingOutputBytes = 0
          pendingOutputOverflowed = false
          read = await runtime.readTerminal(params.terminal)
          serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, isMobile)
          if (closed) {
            return
          }
          if (pendingOutputOverflowed) {
            initialOutputOverflowed = true
            pendingOutput.splice(0)
            pendingOutputBytes = 0
            pendingOutputOverflowed = false
          }
        }
        const size = runtime.getTerminalSize(ptyId)
        const displayMode = runtime.getMobileDisplayMode(ptyId)
        // Why: emit the current layout seq with the initial scrollback so
        // the mobile client's stale-event filter knows the high-water mark.
        // Undefined when the PTY has never transitioned (filter is fail-open).
        // See docs/mobile-terminal-layout-state-machine.md.
        const layoutSeq = runtime.getLayout(ptyId)?.seq
        const snapshotFrameSeq = serialized?.seq ?? layoutSeq
        // Why: recovery snapshots advance output coverage past the initial
        // snapshot seq; query replay and boundary trims must track the seq
        // that actually covered the buffered chunks or a query absorbed by a
        // recovery snapshot gets zero replies.
        let snapshotOutputSeq = serialized?.seq
        emit({
          type: 'subscribed',
          streamId,
          lines: read.tail,
          truncated:
            initialOutputOverflowed ||
            (serialized ? read.truncated : isTerminalReadPayloadIncomplete(read)),
          cols: serialized?.cols ?? size?.cols,
          rows: serialized?.rows ?? size?.rows,
          displayMode,
          seq: layoutSeq
        })
        const snapshotStats = sendSnapshotFrames(sendFrame, {
          kind: 'scrollback',
          cols: serialized?.cols ?? size?.cols ?? 80,
          rows: serialized?.rows ?? size?.rows ?? 24,
          displayMode,
          seq: snapshotFrameSeq,
          cwd: serialized?.cwd,
          truncated:
            initialOutputOverflowed ||
            (serialized ? read.truncated : isTerminalReadPayloadIncomplete(read)),
          truncatedByByteBudget: serialized?.truncatedByByteBudget,
          oscLinks: serialized?.oscLinks,
          data: serialized?.data ?? ''
        })
        console.log('[mobile-terminal-stream] snapshot', {
          terminal: params.terminal,
          streamId,
          kind: 'scrollback',
          bytes: snapshotStats.bytes,
          chunks: snapshotStats.chunks,
          scrollbackRows: serialized?.scrollbackRows,
          truncatedByByteBudget: serialized?.truncatedByByteBudget === true
        })
        // Why: baseline for resize re-stream gating; the client already
        // rewrapped to these cols via the initial snapshot replay.
        lastResizeCols = serialized?.cols ?? size?.cols
        let recoveryAttempts = 0
        // Why: if the bounded pre-subscribe tail overflowed, only a fresh
        // model snapshot can cover the dropped middle without replay gaps.
        while (pendingOutputOverflowed && recoveryAttempts < 2) {
          pendingOutputOverflowed = false
          recoveryAttempts += 1
          const recovery = await serializeBudgetedMobileSnapshot(runtime, ptyId, isMobile)
          if (closed) {
            return
          }
          if (!recovery) {
            break
          }
          // Why: without an output seq (renderer-source fallback) covered
          // chunks cannot be trimmed exactly, and the renderer view may lag
          // the queued chunks under backpressure. Keep the bounded replay
          // instead of applying an unverifiable snapshot.
          if (typeof recovery.seq !== 'number') {
            break
          }
          // Why: shipped mobile clients drop a second scrollback snapshot for
          // an initialized handle but apply a resized snapshot inline by
          // re-initializing xterm with fresh scrollback. Omit seq on the wire
          // so the client's layout-seq staleness filter is not polluted with
          // output-byte sequences.
          const recoveryStats = sendSnapshotFrames(sendFrame, {
            kind: 'resized',
            cols: recovery.cols,
            rows: recovery.rows,
            displayMode,
            reason: 'pending-output-overflow',
            source: recovery.source,
            truncated: false,
            truncatedByByteBudget: recovery.truncatedByByteBudget,
            data: recovery.data
          })
          console.log('[mobile-terminal-stream] recovery snapshot', {
            terminal: params.terminal,
            streamId,
            reason: 'pending-output-overflow',
            bytes: recoveryStats.bytes,
            chunks: recoveryStats.chunks,
            scrollbackRows: recovery.scrollbackRows,
            truncatedByByteBudget: recovery.truncatedByByteBudget === true
          })
          const trimmed = trimPendingOutputCoveredBySnapshot(pendingOutput, recovery.seq)
          pendingOutput = trimmed.chunks
          pendingOutputBytes = trimmed.bytes
          snapshotOutputSeq = recovery.seq
        }
        buffering = false
        const bufferedOutput = pendingOutput.splice(0)
        const queryReplayData = pendingQueryOverflowed
          ? ''
          : pendingQuerySequences
              .filter(
                (query) =>
                  initialOutputOverflowed ||
                  (typeof snapshotOutputSeq === 'number' && query.startSeq < snapshotOutputSeq)
              )
              .map((query) => query.data)
              .join('')
        if (queryReplayData) {
          // Why: serialized snapshots omit control queries, yet their output seq
          // can trim the live chunk. Replay only the query after snapshot so the
          // mobile xterm answers once while ordinary output stays deduplicated.
          outputBatcher.push(queryReplayData)
        }
        if (!initialOutputOverflowed) {
          for (const item of bufferedOutput) {
            let uncoveredData = getOutputAfterSnapshotSeq(item, snapshotOutputSeq)
            let uncoveredMeta = item.meta
            if (
              uncoveredData &&
              uncoveredData !== item.data &&
              typeof snapshotOutputSeq === 'number' &&
              typeof item.meta?.seq === 'number' &&
              typeof item.meta.rawLength === 'number'
            ) {
              if (item.meta.rawLength === item.data.length) {
                uncoveredMeta = { ...item.meta, rawLength: uncoveredData.length }
              }
              uncoveredData = stripSnapshotBoundaryQuerySuffixes(
                uncoveredData,
                snapshotOutputSeq,
                snapshotOutputSeq,
                pendingQuerySequences
              )
            }
            if (uncoveredData) {
              outputBatcher.push(uncoveredData, uncoveredMeta)
            }
          }
        }
        pendingOutputBytes = 0
        outputBatcher.flush()
        const lateRendererReady = lateRendererReadyPromise
        lateRendererReadyPromise = null
        if (lateRendererReady) {
          void lateRendererReady
            .then(async (rendererReady) => {
              if (!rendererReady || closed) {
                return
              }
              outputBatcher?.flush()
              const recovery = await serializeStableMobileRendererSnapshot(runtime, ptyId)
              if (closed) {
                return
              }
              if (!recovery?.data.length) {
                return
              }
              // Why: late recovery has no buffered-output gate. Only an exact
              // renderer high-water may reset mobile without erasing live bytes.
              if (recovery.seq !== runtime.getPtyOutputSequence(ptyId)) {
                return
              }
              runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(ptyId, recovery)
              // Why: shipped mobile clients apply resized snapshots in place,
              // allowing a blank initialized xterm to recover without resubscribe.
              const recoveryStats = sendSnapshotFrames(sendFrame, {
                kind: 'resized',
                cols: recovery.cols,
                rows: recovery.rows,
                displayMode,
                reason: 'renderer-mount-ready',
                source: recovery.source,
                truncated: false,
                truncatedByByteBudget: recovery.truncatedByByteBudget,
                data: recovery.data
              })
              lastResizeCols = recovery.cols
              console.log('[mobile-terminal-stream] recovery snapshot', {
                terminal: params.terminal,
                streamId,
                reason: 'renderer-mount-ready',
                bytes: recoveryStats.bytes,
                chunks: recoveryStats.chunks,
                scrollbackRows: recovery.scrollbackRows,
                truncatedByByteBudget: recovery.truncatedByByteBudget === true
              })
            })
            .catch(() => {})
        }
        const sendResizedFrame = (event: {
          cols: number
          rows: number
          displayMode: string
          reason: string
          seq?: number
        }): void => {
          lastResizeCols = event.cols
          sendFrame(
            TerminalStreamOpcode.Resized,
            encodeTerminalStreamJson({
              cols: event.cols,
              rows: event.rows,
              displayMode: event.displayMode,
              reason: event.reason,
              seq: event.seq
            })
          )
        }
        unsubscribeResize = runtime.subscribeToTerminalResize(ptyId, (event) => {
          outputBatcher?.flush()
          const eventGeneration = resizeGeneration + 1
          resizeGeneration = eventGeneration
          // Why: a width reflow rewraps scrollback. xterm can only re-wrap
          // soft-wrapped lines, so a geometry-only Resized frame leaves the
          // hard-wrapped restored snapshot at the old cols. Re-serialize and
          // replay the full buffer at the new width instead. Non-mobile and
          // alt-screen TUIs keep the geometry-only frame + TUI redraw.
          const widthChanged = isMobile && event.cols !== lastResizeCols
          if (widthChanged) {
            lastResizeCols = event.cols
            void sendMobileResizeRestream(
              runtime,
              ptyId,
              sendFrame,
              event,
              () => !closed && resizeGeneration === eventGeneration
            )
              .then((restreamed) => {
                if (closed || resizeGeneration !== eventGeneration) {
                  return
                }
                if (!restreamed) {
                  sendResizedFrame(event)
                }
              })
              // Why: if re-stream serialization/runtime throws, still emit the
              // geometry-only Resized frame so the client never misses the resize.
              .catch(() => {
                if (closed || resizeGeneration !== eventGeneration) {
                  return
                }
                sendResizedFrame(event)
              })
            return
          }
          sendResizedFrame(event)
        })

        // Install the resize listener before draining the parked viewport;
        // applyLayout emits synchronously and the stream must observe it.
        if (
          clientId &&
          params.client &&
          registeredRemoteDesktopDriver &&
          pendingRemoteDesktopViewport
        ) {
          const viewport = pendingRemoteDesktopViewport
          pendingRemoteDesktopViewport = null
          void updateViewportForClient(
            runtime,
            ptyId,
            remoteDesktopSubscriptionKey,
            params.client,
            viewport,
            'desktop',
            'register',
            !supportsDesktopViewportClaims
          ).catch(() => {})
        }

        // Legacy fit-override-changed for non-mobile (desktop) subscribers
        unsubscribeFit = !isMobile
          ? runtime.subscribeToFitOverrideChanges(ptyId, (event) => {
              const mode =
                event.mode === 'mobile-fit'
                  ? event.mode
                  : (runtime.getRemoteDesktopFitHold?.(ptyId, remoteDesktopSubscriptionKey).mode ??
                    'desktop-fit')
              emit({
                type: 'fit-override-changed',
                mode,
                cols: event.cols,
                rows: event.rows
              })
            })
          : () => {}
      } catch (error) {
        runtime.cleanupSubscription(subscriptionId)
        throw error
      }

      await streamClosed
    }
  }),
  defineMethod({
    name: 'terminal.unsubscribe',
    params: TerminalUnsubscribe,
    handler: async (params, { runtime }) => {
      // Why: the subscribe handler now registers cleanup under a composite
      // key `${terminal}:${clientId}`. New mobile builds emit the composite
      // key directly. Older builds emit a bare-handle subscriptionId; if
      // they additionally provide `client.id`, reconstruct the composite
      // key server-side. We always try the as-sent value first, then fall
      // back to the reconstructed composite, so both wire formats work.
      runtime.cleanupSubscription(params.subscriptionId)
      if (params.client && !params.subscriptionId.includes(':')) {
        runtime.cleanupSubscription(`${params.subscriptionId}:${params.client.id}`)
      }
      return { unsubscribed: true }
    }
  }),
  defineMethod({
    name: 'terminal.getAutoRestoreFit',
    params: z.object({}),
    handler: async (_params, { runtime }) => ({
      ms: runtime.getMobileAutoRestoreFitMs()
    })
  }),
  defineMethod({
    name: 'terminal.setAutoRestoreFit',
    params: TerminalSetAutoRestoreFit,
    handler: async (params, { runtime }) => ({
      ms: runtime.setMobileAutoRestoreFitMs(params.ms)
    })
  })
]
