import { Buffer } from 'buffer/'
import { sha256 } from '@noble/hashes/sha256'
import {
  MOBILE_WEB_TERMINAL_MAX_OUTPUT_BATCH_BYTES,
  MOBILE_WEB_TERMINAL_MAX_SNAPSHOT_BYTES,
  MOBILE_WEB_TERMINAL_SNAPSHOT_CHUNK_BYTES,
  MobileWebTerminalOscLinksSchema,
  type MobileWebTerminalOscLinkRange,
  type MobileWebTerminalEvent
} from '../../../src/shared/mobile-web/terminal-stream-contract'
import {
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  TerminalStreamOpcode,
  type TerminalStreamFrame
} from '../transport/terminal-stream-protocol'

export type HostSnapshot = {
  kind: 'initial' | 'resize' | 'resync'
  viewport: { cols: number; rows: number }
  truncated: boolean
  source: 'host-model' | 'renderer'
  oscLinks?: MobileWebTerminalOscLinkRange[]
  chunks: Uint8Array[]
  totalBytes: number
}

export function startHostSnapshot(frame: TerminalStreamFrame): HostSnapshot | null {
  const value = decodeTerminalStreamJson<Record<string, unknown>>(frame.payload)
  const oscLinks = MobileWebTerminalOscLinksSchema.safeParse(value?.oscLinks)
  if (
    !value ||
    typeof value.cols !== 'number' ||
    typeof value.rows !== 'number' ||
    !Number.isInteger(value.cols) ||
    !Number.isInteger(value.rows) ||
    value.cols < 2 ||
    value.cols > 1_000 ||
    value.rows < 1 ||
    value.rows > 1_000 ||
    (value.oscLinks !== undefined && !oscLinks.success)
  ) {
    return null
  }
  return {
    kind:
      value.kind === 'resized'
        ? 'resize'
        : value.kind === 'scrollback' && value.reason
          ? 'resync'
          : 'initial',
    viewport: { cols: value.cols, rows: value.rows },
    truncated: value.truncated === true || value.truncatedByByteBudget === true,
    source: value.source === 'renderer' ? 'renderer' : 'host-model',
    ...(value.oscLinks !== undefined && oscLinks.success ? { oscLinks: oscLinks.data } : {}),
    chunks: [],
    totalBytes: 0
  }
}

export function appendHostSnapshotChunk(snapshot: HostSnapshot, payload: Uint8Array): boolean {
  if (snapshot.totalBytes + payload.byteLength > MOBILE_WEB_TERMINAL_MAX_SNAPSHOT_BYTES) {
    return false
  }
  snapshot.chunks.push(payload)
  snapshot.totalBytes += payload.byteLength
  return true
}

export function finishHostSnapshot(
  snapshot: HostSnapshot,
  streamId: string,
  snapshotId: string,
  throughSequence: number
): MobileWebTerminalEvent[] {
  const bytes = concatBytes(snapshot.chunks, snapshot.totalBytes)
  const hash = Buffer.from(sha256(bytes)).toString('hex')
  const events: MobileWebTerminalEvent[] = [
    {
      type: 'snapshotStart',
      streamId,
      snapshotId,
      kind: snapshot.kind,
      viewport: snapshot.viewport,
      totalBytes: bytes.byteLength,
      throughSequence,
      sha256: hash,
      truncated: snapshot.truncated,
      source: snapshot.source,
      ...(snapshot.oscLinks ? { oscLinks: snapshot.oscLinks } : {})
    }
  ]
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += MOBILE_WEB_TERMINAL_SNAPSHOT_CHUNK_BYTES
  ) {
    const chunk = bytes.subarray(offset, offset + MOBILE_WEB_TERMINAL_SNAPSHOT_CHUNK_BYTES)
    events.push({
      type: 'snapshotChunk',
      streamId,
      snapshotId,
      offset,
      data: Buffer.from(chunk).toString('base64')
    })
  }
  events.push({
    type: 'snapshotEnd',
    streamId,
    snapshotId,
    totalBytes: bytes.byteLength,
    throughSequence,
    sha256: hash
  })
  return events
}

export function decodeHostOutput(frame: TerminalStreamFrame): Uint8Array[] | null {
  let text: string
  if (frame.opcode === TerminalStreamOpcode.OutputSpan) {
    const value = decodeTerminalStreamJson<Record<string, unknown>>(frame.payload)
    if (!value || typeof value.data !== 'string') {
      return null
    }
    text = value.data
  } else if (frame.opcode === TerminalStreamOpcode.Output) {
    text = decodeTerminalStreamText(frame.payload)
  } else {
    return null
  }
  const bytes = new TextEncoder().encode(text)
  const chunks: Uint8Array[] = []
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += MOBILE_WEB_TERMINAL_MAX_OUTPUT_BATCH_BYTES
  ) {
    chunks.push(bytes.subarray(offset, offset + MOBILE_WEB_TERMINAL_MAX_OUTPUT_BATCH_BYTES))
  }
  return chunks
}

function concatBytes(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
