import type { SnapshotFrameOptions } from './terminal-stream-types'

/** Share actual metadata between sender and budget; a remembered field list previously undercounted the frame. */
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
    // Additive fields need no negotiation: older clients ignore them, newer clients treat absence as unknown.
    // Flags require their own seq so clients can order them (docs/reference/remote-wire-compatibility.md).
    ...(typeof options.seq === 'number' && options.kittyKeyboardFlags !== undefined
      ? { kittyKeyboardFlags: options.kittyKeyboardFlags }
      : {}),
    ...(typeof options.seq === 'number' && options.terminalOwner
      ? { terminalOwner: options.terminalOwner }
      : {}),
    // Consumers do not recheck terminalOwner; ungated alternateScreen changes mouse-reset selection on live TUI reattach.
    ...(typeof options.seq === 'number' &&
    options.terminalOwner &&
    options.alternateScreen !== undefined
      ? { alternateScreen: options.alternateScreen }
      : {}),
    truncated: options.truncated === true,
    truncatedByByteBudget: options.truncatedByByteBudget === true,
    // Older hosts omit this; absence means unknown, not zero rows.
    ...(typeof options.scrollbackRows === 'number'
      ? { scrollbackRows: options.scrollbackRows }
      : {})
  }
}

/** Measure the client-assembled JSON object, including metadata and escaping; copying up to six times per attach avoids field-list drift. */
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
