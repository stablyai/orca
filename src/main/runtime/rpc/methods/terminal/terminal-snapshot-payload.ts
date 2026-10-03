import type { SnapshotFrameOptions } from './terminal-stream-types'

/**
 * The shape of a snapshot on the wire, and what it costs a client that reads it as one payload.
 *
 * Split from the publication so the budget and the sender read one description of the frame. They
 * used not to: the budget summed the fields somebody remembered and shipped a payload 169 bytes
 * over the 655,360-byte cap while calling it budgeted, on a frame carrying an 8-character request
 * id. The overshoot grows with that id: a 24-character one is 247 bytes over.
 */

/**
 * The metadata a SnapshotStart frame carries, built in one place.
 *
 * Extracted so the budget below measures the object this really sends rather than a list of the
 * fields somebody remembered. A sum over a remembered list is what shipped those 169 bytes: it
 * counted the text and four fields and forgot
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
