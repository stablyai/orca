// Unit 6: pure wire-shape builders for terminal.subscribe's two publication modes (spec S6,
// verified against src/main/runtime/rpc/methods/terminal/terminal-snapshot-publication.ts and
// terminal-legacy-subscribe-snapshot.ts — terminal.subscribe is the legacy single-stream method,
// not terminal.multiplex). Kept side-effect-free so MockOrcaServer only wires sockets/encryption.
import { TerminalStreamOpcode } from '@orca-shared/terminal-stream-protocol'

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const DEFAULT_DISPLAY_MODE = 'auto'

export type MockTerminalGeometry = {
  cols?: number
  rows?: number
  displayMode?: string
}

/** The real host's `emit({type:'subscribed', ...})` control message for a binary-capable
 *  subscription (publishLegacyBinaryInitialSnapshot) — NOT `{subscriptionId}` (that belongs to
 *  the unrelated clientEvents/screencast family) and NOT the multiplex family's `terminal` field. */
export function buildSubscribedControlMessage(
  streamId: number,
  scrollbackLines: string[],
  geometry: MockTerminalGeometry = {}
): Record<string, unknown> {
  return {
    type: 'subscribed',
    streamId,
    lines: scrollbackLines,
    truncated: false,
    cols: geometry.cols ?? DEFAULT_COLS,
    rows: geometry.rows ?? DEFAULT_ROWS,
    displayMode: geometry.displayMode ?? DEFAULT_DISPLAY_MODE
  }
}

/** The JSON-fallback path's (runTerminalJsonSubscription) only initial emit — there is no
 *  separate `{type:'subscribed'}` control message when the binary capability wasn't requested. */
export function buildScrollbackControlMessage(
  scrollbackLines: string[],
  geometry: MockTerminalGeometry = {}
): Record<string, unknown> {
  return {
    type: 'scrollback',
    lines: scrollbackLines,
    truncated: false,
    cols: geometry.cols ?? DEFAULT_COLS,
    rows: geometry.rows ?? DEFAULT_ROWS,
    displayMode: geometry.displayMode ?? DEFAULT_DISPLAY_MODE
  }
}

/** JSON-fallback path's per-chunk push (`emit({type:'data', chunk})`). */
export function buildDataMessage(chunk: string): Record<string, unknown> {
  return { type: 'data', chunk }
}

export type MockSnapshotFrame = { opcode: TerminalStreamOpcode; text: string }

/** Mirrors `sendSnapshotFrames`'s three binary frames exactly: SnapshotStart carries JSON
 *  metadata (never terminal text — HIGH finding terminal-tail-decoder.ts:65 is about a decoder
 *  that got this backwards), SnapshotChunk carries the actual scrollback text, SnapshotEnd is
 *  empty. */
export function buildSnapshotFrames(
  scrollback: string,
  geometry: MockTerminalGeometry = {}
): MockSnapshotFrame[] {
  const metadata = {
    kind: 'scrollback',
    cols: geometry.cols ?? DEFAULT_COLS,
    rows: geometry.rows ?? DEFAULT_ROWS,
    displayMode: geometry.displayMode ?? DEFAULT_DISPLAY_MODE,
    truncated: false,
    truncatedByByteBudget: false
  }
  return [
    { opcode: TerminalStreamOpcode.SnapshotStart, text: JSON.stringify(metadata) },
    { opcode: TerminalStreamOpcode.SnapshotChunk, text: scrollback },
    { opcode: TerminalStreamOpcode.SnapshotEnd, text: '' }
  ]
}
