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

/** E2E-only: reproduce a host that retains nothing for a pty — the state a client cannot tell
 *  apart from a host that is merely slow, and the one a parked pane must survive. Mirrors
 *  ORCA_E2E_FORCE_REMOTE_TERMINAL_INITIAL_SNAPSHOT_TRUNCATED. */
function isTerminalSnapshotForcedUnavailable(): boolean {
  return process.env.ORCA_E2E_FORCE_REMOTE_TERMINAL_SNAPSHOT_UNAVAILABLE === '1'
}

export async function serializeBudgetedRequestedSnapshot(
  runtime: OrcaRuntimeService,
  ptyId: string,
  scrollbackRows: number | undefined
): Promise<SerializedSnapshot> {
  if (isTerminalSnapshotForcedUnavailable()) {
    return null
  }
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

/**
 * The metadata a SnapshotStart frame carries, built in one place.
 *
 * Extracted so the budget below measures the object this really sends rather than a list of the
 * fields somebody remembered. A sum over a remembered list is what shipped a payload 169 bytes over
 * a 655,360-byte cap while calling it budgeted: it counted the text and four fields and forgot
 * `kind`, `cols`, `rows`, `requestId`, `displayMode`, `reason`, `seq`, both truncation flags and
 * the `serialized` key itself. A field added here is now paid for by both readers at once.
 */
export function buildSnapshotFrameMeta(options: SnapshotFrameOptions): Record<string, unknown> {
  return {
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
  }
}

/**
 * What a bridged client's scrollback event costs, as the client assembles it.
 *
 * The client joins the chunks and spreads the metadata into one object with `type`, `streamId` and
 * `serialized` beside it, and its transport measures the serialized result. So this builds that
 * object and stringifies it: nothing is summed, nothing is estimated, and a field that joins the
 * metadata is counted here the moment it is sent.
 *
 * A copy of the snapshot per call, which the trimming loop pays up to six times on a subscribe.
 * That is the price of the only measure that cannot be wrong by a field, on a path that runs once
 * per terminal attach.
 */
export function terminalSnapshotPayloadJsonBytes(
  options: SnapshotFrameOptions,
  streamId: number
): number {
  return Buffer.byteLength(
    JSON.stringify({
      ...buildSnapshotFrameMeta(options),
      type: options.kind,
      streamId,
      serialized: options.data
    }),
    'utf8'
  )
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
      encodeTerminalStreamJson(buildSnapshotFrameMeta(options))
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

/** The publication fields a snapshot itself decides, which the budget reads off it. */
type SnapshotVariableMeta = Pick<
  NonNullable<SerializedSnapshot>,
  | 'cwd'
  | 'oscLinks'
  | 'pendingEscapeTailAnsi'
  | 'source'
  | 'seq'
  | 'kittyKeyboardFlags'
  | 'alternateScreen'
  | 'terminalOwner'
>

/** Narrowed to the one method this reads, so a caller can hand it a buffer source and nothing else. */
type TerminalBufferSource = Pick<OrcaRuntimeService, 'serializeTerminalBuffer'>

/**
 * What a subscriber with a frame cap told this host it can carry, and what it will publish with.
 *
 * The publication fields travel with the budget because the payload is measured by building it,
 * and it cannot be built from the snapshot alone: `displayMode`, `reason` and `requestId` are the
 * caller's, and a measure that left them out is exactly the sum that shipped a frame over the cap.
 */
export type MobileSnapshotByteBudget = {
  /** The bytes one payload may occupy on this subscriber's transport. */
  bytes: number
  /** The stream this will be published on, which the client writes into the payload. */
  streamId: number
  /** The publication's own fields, as the caller will pass them to `sendSnapshotFrames`. */
  frame: Omit<
    SnapshotFrameOptions,
    | 'data'
    | 'cols'
    | 'rows'
    | 'cwd'
    | 'source'
    | 'oscLinks'
    | 'pendingEscapeTailAnsi'
    | 'kittyKeyboardFlags'
    | 'alternateScreen'
    | 'terminalOwner'
    | 'truncatedByByteBudget'
  >
}

/** `JSON.stringify` writes `false` in five bytes and `true` in four, so `false` is the bound. */
const WIDEST_BOOLEAN = false

/**
 * The publication this snapshot would produce, at its widest where the answer is not yet known.
 *
 * A bound rather than a prediction, and the direction matters: `truncated` is decided after this
 * runs and `seq` and `requestId` may be, so each is taken at the widest `JSON.stringify` can write
 * rather than left out. Leaving one out is what under-measures, because an absent field costs
 * nothing here and its real value costs bytes at publish — and forcing `seq` to a number also opens
 * the three conditional fields it gates, which are counted for the same reason.
 */
function budgetedPublication(
  data: string,
  serialized: SnapshotVariableMeta & { cols: number; rows: number },
  budget: MobileSnapshotByteBudget
): SnapshotFrameOptions {
  return {
    ...budget.frame,
    requestId: budget.frame.requestId ?? Number.MAX_SAFE_INTEGER,
    seq: budget.frame.seq ?? serialized.seq ?? Number.MAX_SAFE_INTEGER,
    truncated: WIDEST_BOOLEAN,
    truncatedByByteBudget: WIDEST_BOOLEAN,
    cols: serialized.cols,
    rows: serialized.rows,
    cwd: serialized.cwd,
    source: serialized.source,
    oscLinks: serialized.oscLinks,
    pendingEscapeTailAnsi: serialized.pendingEscapeTailAnsi,
    kittyKeyboardFlags: serialized.kittyKeyboardFlags,
    alternateScreen: serialized.alternateScreen,
    terminalOwner: serialized.terminalOwner,
    data
  }
}

/**
 * Whether this snapshot is over whichever budget the subscriber is owed.
 *
 * Two budgets, not one scaled: a subscriber with a frame cap sends one and is measured on the
 * payload it will receive, built rather than summed, and everyone else keeps the raw-text budget
 * this host has always applied. Reading the payload size for a socket subscriber would shrink a
 * screen that was never at risk, and reading the raw size for a bridged one is the defect this
 * parameter exists for.
 */
function overMobileSnapshotBudget(
  data: string,
  serialized: SnapshotVariableMeta & { cols: number; rows: number },
  budget: MobileSnapshotByteBudget | undefined
): boolean {
  return budget === undefined
    ? terminalStreamByteLengthExceeds(data, MOBILE_SNAPSHOT_BYTE_BUDGET)
    : terminalSnapshotPayloadJsonBytes(
        budgetedPublication(data, serialized, budget),
        budget.streamId
      ) > budget.bytes
}

export async function serializeBudgetedMobileSnapshot(
  runtime: TerminalBufferSource,
  ptyId: string,
  isMobile: boolean,
  snapshotByteBudget?: MobileSnapshotByteBudget
): Promise<SerializedSnapshot> {
  if (isTerminalSnapshotForcedUnavailable()) {
    return null
  }
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
    const overByteBudget = overMobileSnapshotBudget(data, serialized, snapshotByteBudget)
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
  ptyId: string,
  snapshotByteBudget?: MobileSnapshotByteBudget
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
    const overByteBudget = overMobileSnapshotBudget(serialized.data, serialized, snapshotByteBudget)
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
  shouldSend?: () => boolean,
  snapshotByteBudget?: MobileSnapshotByteBudget
): Promise<boolean> {
  // Why: only a true geometry reflow rewraps scrollback; a dimensionless mode-change would re-send the whole buffer for nothing.
  if (event.reason !== 'apply-layout' || runtime.isTerminalAlternateScreen(ptyId)) {
    return false
  }
  const serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, true, snapshotByteBudget)
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

/**
 * The budget a subscription hands the serializer, or nothing when the subscriber named none.
 *
 * Built at each publication site rather than once per subscription, because the fields it carries
 * are that publication's: an initial scrollback and a resize re-stream write different `kind`s and
 * `reason`s, and a budget measured against the wrong one is the sum this replaced.
 */
export function mobileSnapshotByteBudget(
  bytes: number | undefined,
  streamId: number,
  frame: MobileSnapshotByteBudget['frame']
): MobileSnapshotByteBudget | undefined {
  return bytes === undefined ? undefined : { bytes, streamId, frame }
}
