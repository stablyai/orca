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
import {
  buildSnapshotFrameMeta,
  terminalSnapshotPayloadJsonBytes
} from './terminal-snapshot-payload'
import type { SerializedSnapshot, SnapshotFrameOptions } from './terminal-stream-types'

const REQUESTED_SNAPSHOT_BYTE_BUDGET = 2 * 1024 * 1024

/** E2E-only: simulate unavailable retained state, which a parked client cannot distinguish from slow hydration. */
export function isTerminalSnapshotForcedUnavailable(): boolean {
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
  | 'lastTitle'
>

type TerminalBufferSource = Pick<OrcaRuntimeService, 'serializeTerminalBuffer'>

/** Carry publication fields with the cap: measuring snapshot text alone omits caller-owned metadata. */
export type MobileSnapshotByteBudget = {
  bytes: number
  streamId: number
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
    | 'lastTitle'
    | 'truncatedByByteBudget'
  >
}

/** `JSON.stringify` writes `false` in five bytes and `true` in four, so `false` is the bound. */
const WIDEST_BOOLEAN = false

type MobileDisplayMode = ReturnType<OrcaRuntimeService['getMobileDisplayMode']>

const DISPLAY_MODES = ['auto', 'desktop'] as const satisfies readonly MobileDisplayMode[]

type UnlistedDisplayMode = Exclude<MobileDisplayMode, (typeof DISPLAY_MODES)[number]>

/** Mode is re-read before publication, so budget its widest value; the never guard forces new modes into this list. */
const WIDEST_DISPLAY_MODE: [UnlistedDisplayMode] extends [never] ? string : never =
  DISPLAY_MODES.reduce((widest, mode) => (mode.length > widest.length ? mode : widest))

/** Unknown publication fields need their widest JSON values; numeric seq also enables conditional metadata that must be counted. */
function budgetedPublication(
  data: string,
  serialized: SnapshotVariableMeta & { cols: number; rows: number },
  budget: MobileSnapshotByteBudget
): SnapshotFrameOptions {
  return {
    ...budget.frame,
    displayMode: WIDEST_DISPLAY_MODE,
    requestId: budget.frame.requestId ?? Number.MAX_SAFE_INTEGER,
    seq: budget.frame.seq ?? serialized.seq ?? Number.MAX_SAFE_INTEGER,
    truncated: WIDEST_BOOLEAN,
    truncatedByByteBudget: WIDEST_BOOLEAN,
    scrollbackRows: MOBILE_SUBSCRIBE_SCROLLBACK_ROWS,
    cols: serialized.cols,
    rows: serialized.rows,
    cwd: serialized.cwd,
    source: serialized.source,
    oscLinks: serialized.oscLinks,
    pendingEscapeTailAnsi: serialized.pendingEscapeTailAnsi,
    kittyKeyboardFlags: serialized.kittyKeyboardFlags,
    alternateScreen: serialized.alternateScreen,
    terminalOwner: serialized.terminalOwner,
    lastTitle: serialized.lastTitle,
    data
  }
}

/** Capped clients need whole-payload JSON measurement; uncapped older/socket clients retain the raw-text budget. */
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

/** If zero scrollback still exceeds a supplied cap, empty text so later output can repaint; metadata may still exceed the cap.
 * Unbudgeted clients retain the oversized screen fallback. */
function publishedCandidate<T extends SnapshotVariableMeta & { cols: number; rows: number }>(
  serialized: T,
  data: string,
  rows: number,
  overByteBudget: boolean,
  budget: MobileSnapshotByteBudget | undefined
) {
  return {
    ...serialized,
    data: overByteBudget && budget !== undefined ? '' : data,
    scrollbackRows: rows,
    truncatedByByteBudget: rows < MOBILE_SUBSCRIBE_SCROLLBACK_ROWS || overByteBudget
  }
}

export async function serializeBudgetedMobileSnapshot(
  runtime: TerminalBufferSource,
  ptyId: string,
  snapshotByteBudget?: MobileSnapshotByteBudget,
  /** Rows to try first; only a WSL-moved pane asks for more than the default. */
  firstRows = MOBILE_SUBSCRIBE_SCROLLBACK_ROWS
): Promise<SerializedSnapshot> {
  if (isTerminalSnapshotForcedUnavailable()) {
    return null
  }
  // Include history for desktop too; screen-only snapshots lost it on remount/reconnect (#20158).
  const candidates = [
    ...(firstRows > MOBILE_SUBSCRIBE_SCROLLBACK_ROWS ? [firstRows, 2000] : []),
    MOBILE_SUBSCRIBE_SCROLLBACK_ROWS,
    500,
    250,
    100,
    25,
    0
  ]
  for (const rows of candidates) {
    const serialized = await runtime.serializeTerminalBuffer(ptyId, { scrollbackRows: rows })
    if (!serialized) {
      return null
    }
    const data = (serialized.scrollbackAnsi ?? '') + serialized.data
    const overByteBudget = overMobileSnapshotBudget(data, serialized, snapshotByteBudget)
    if (!overByteBudget || rows === 0) {
      return publishedCandidate(serialized, data, rows, overByteBudget, snapshotByteBudget)
    }
  }
  return null
}

type RendererBufferSource = Pick<
  OrcaRuntimeService,
  'getPtyOutputSequence' | 'serializeRendererTerminalBuffer'
>

export async function serializeStableMobileRendererSnapshot(
  runtime: RendererBufferSource,
  ptyId: string,
  snapshotByteBudget?: MobileSnapshotByteBudget
): Promise<SerializedSnapshot> {
  const candidates = [MOBILE_SUBSCRIBE_SCROLLBACK_ROWS, 500, 250, 100, 25, 0]
  let candidateIndex = 0
  for (let attempt = 0; attempt < candidates.length; attempt += 1) {
    // Advance toward zero scrollback even on retries so the final attempt reaches the smallest candidate.
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
      return publishedCandidate(
        serialized,
        serialized.data,
        rows,
        overByteBudget,
        snapshotByteBudget
      )
    }
    candidateIndex += 1
  }
  return null
}

// Restored hard newlines cannot rewrap in mobile xterm; reserialize the full buffer at the new columns.
export async function sendMobileResizeRestream(
  runtime: OrcaRuntimeService,
  ptyId: string,
  sendFrame: (opcode: TerminalStreamOpcode, payload?: Uint8Array<ArrayBufferLike>) => void,
  event: { cols: number; rows: number; displayMode: string; reason: string; seq?: number },
  shouldSend?: () => boolean,
  snapshotByteBudget?: MobileSnapshotByteBudget
): Promise<boolean> {
  // Only geometry reflow rewraps history; mode-only changes need no replay.
  if (event.reason !== 'apply-layout' || runtime.isTerminalAlternateScreen(ptyId)) {
    return false
  }
  const serialized = await serializeBudgetedMobileSnapshot(runtime, ptyId, snapshotByteBudget)
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

/** Pass the same frame object to budget and publication at each send site to prevent kind/reason drift.
 * Unknown seq, requestId, truncation flags and re-read displayMode are budgeted at their widest values. */
export function mobileSnapshotByteBudget(
  bytes: number | undefined,
  streamId: number,
  frame: MobileSnapshotByteBudget['frame']
): MobileSnapshotByteBudget | undefined {
  return bytes === undefined ? undefined : { bytes, streamId, frame }
}
