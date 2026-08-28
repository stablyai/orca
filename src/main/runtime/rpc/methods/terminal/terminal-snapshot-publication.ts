import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  TerminalStreamOpcode,
  encodeTerminalStreamJson
} from '../../../../../shared/terminal-stream-protocol'
import {
  MOBILE_SNAPSHOT_BYTE_BUDGET,
  MOBILE_SUBSCRIBE_SCROLLBACK_ROWS
} from '../../../scrollback-limits'
import { terminalStreamByteLengthExceeds } from '../../terminal-stream-byte-length'
import {
  iterateTerminalStreamTextPayloads,
  requestedSnapshotScrollbackCandidates
} from './terminal-stream-replay'
import type { SerializedSnapshot, SnapshotFrameOptions } from './terminal-stream-types'

const REQUESTED_SNAPSHOT_BYTE_BUDGET = 2 * 1024 * 1024

export async function serializeBudgetedRequestedSnapshot(
  runtime: OrcaRuntimeService,
  ptyId: string,
  scrollbackRows: number | undefined
): Promise<SerializedSnapshot> {
  const requestedRows = scrollbackRows ?? 0
  for (const rows of requestedSnapshotScrollbackCandidates(scrollbackRows)) {
    const serialized = await runtime.serializeAuthoritativeTerminalBuffer(ptyId, {
      scrollbackRows: rows
    })
    if (!serialized) {
      return null
    }
    const scrollbackAnsi =
      'scrollbackAnsi' in serialized && typeof serialized.scrollbackAnsi === 'string'
        ? serialized.scrollbackAnsi
        : ''
    const data = scrollbackAnsi + serialized.data
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

export function sendSnapshotFrames(
  sendFrame: (
    opcode: TerminalStreamOpcode,
    payload?: Uint8Array<ArrayBufferLike>
  ) => boolean | void,
  options: SnapshotFrameOptions
): { bytes: number; chunks: number; published: boolean } {
  if (
    sendFrame(
      TerminalStreamOpcode.SnapshotStart,
      encodeTerminalStreamJson({
        kind: options.kind,
        cols: options.cols,
        rows: options.rows,
        requestId: options.requestId,
        displayMode: options.displayMode,
        reason: options.reason,
        unavailable: options.unavailable,
        seq: options.seq,
        cwd: options.cwd,
        source: options.source,
        oscLinks: options.oscLinks,
        pendingEscapeTailAnsi: options.pendingEscapeTailAnsi,
        // Why conditional and additive: old clients ignore the unknown field,
        // and a new client must read absence as unknown rather than zero, so
        // no opcode or capability negotiation is involved (Rule 1 of
        // docs/reference/remote-wire-compatibility.md).
        // Why `seq` is required: the flags are only proven at this frame's own
        // seq, so without a replay boundary the client cannot order them.
        ...(typeof options.seq === 'number' && options.kittyKeyboardFlags !== undefined
          ? { kittyKeyboardFlags: options.kittyKeyboardFlags }
          : {}),
        ...(typeof options.seq === 'number' && options.terminalOwner
          ? { terminalOwner: options.terminalOwner }
          : {}),
        // The terminalOwner conjunct is load-bearing, not redundant: no consumer
        // re-checks it, and an un-gated alternateScreen would flip the renderer's
        // mouse-reset selection on every alt-screen reattach of a live TUI.
        ...(typeof options.seq === 'number' &&
        options.terminalOwner &&
        options.alternateScreen !== undefined
          ? { alternateScreen: options.alternateScreen }
          : {}),
        truncated: options.truncated === true,
        truncatedByByteBudget: options.truncatedByByteBudget === true
      })
    ) === false
  ) {
    return { bytes: 0, chunks: 0, published: false }
  }
  let chunks = 0
  let bytes = 0
  for (const chunk of iterateTerminalStreamTextPayloads(options.data)) {
    if (sendFrame(TerminalStreamOpcode.SnapshotChunk, chunk) === false) {
      return { bytes, chunks, published: false }
    }
    chunks++
    bytes += chunk.byteLength
  }
  const published = sendFrame(TerminalStreamOpcode.SnapshotEnd) !== false
  return { bytes, chunks, published }
}

export async function serializeBudgetedMobileSnapshot(
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

export async function serializeStableMobileRendererSnapshot(
  runtime: OrcaRuntimeService,
  ptyId: string
): Promise<SerializedSnapshot> {
  const candidates = [MOBILE_SUBSCRIBE_SCROLLBACK_ROWS, 500, 250, 100, 25, 0]
  let candidateIndex = 0
  for (let attempt = 0; attempt < candidates.length; attempt += 1) {
    // Why: advance toward zero scrollback each retry so the final attempt always has a bounded payload.
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

// Why: mobile xterm can't rewrap the HARD newlines baked into a restored snapshot, so a real reflow re-serializes and replays the FULL buffer at the new cols.
export async function sendMobileResizeRestream(
  runtime: OrcaRuntimeService,
  ptyId: string,
  sendFrame: (opcode: TerminalStreamOpcode, payload?: Uint8Array<ArrayBufferLike>) => void,
  event: { cols: number; rows: number; displayMode: string; reason: string; seq?: number },
  shouldSend?: () => boolean
): Promise<boolean> {
  // Why: only a true geometry reflow rewraps scrollback; a dimensionless mode-change would re-send the whole buffer for nothing.
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
