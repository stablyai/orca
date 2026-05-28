const TERMINAL_STREAM_KIND = 0x74
const TERMINAL_STREAM_VERSION = 1
const HEADER_BYTES = 16

export enum TerminalStreamOpcode {
  Output = 1,
  SnapshotStart = 2,
  SnapshotChunk = 3,
  SnapshotEnd = 4,
  Resized = 5,
  Error = 6
}

export type TerminalStreamFrame = {
  opcode: TerminalStreamOpcode
  streamId: number
  seq: number
  payload: Uint8Array
}

export function encodeTerminalStreamFrame(frame: TerminalStreamFrame): Uint8Array {
  const out = new Uint8Array(HEADER_BYTES + frame.payload.length)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint8(0, TERMINAL_STREAM_KIND)
  view.setUint8(1, TERMINAL_STREAM_VERSION)
  view.setUint8(2, frame.opcode)
  view.setUint8(3, 0)
  view.setUint32(4, frame.streamId, true)
  const seq = Math.max(0, Math.floor(frame.seq))
  view.setUint32(8, Math.floor(seq / 0x100000000), true)
  view.setUint32(12, seq >>> 0, true)
  out.set(frame.payload, HEADER_BYTES)
  return out
}

export function decodeTerminalStreamFrame(bytes: Uint8Array): TerminalStreamFrame | null {
  if (bytes.length < HEADER_BYTES) {
    return null
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint8(0) !== TERMINAL_STREAM_KIND || view.getUint8(1) !== TERMINAL_STREAM_VERSION) {
    return null
  }
  const opcode = view.getUint8(2)
  if (!isTerminalStreamOpcode(opcode)) {
    return null
  }
  const high = view.getUint32(8, true)
  const low = view.getUint32(12, true)
  return {
    opcode,
    streamId: view.getUint32(4, true),
    seq: high * 0x100000000 + low,
    payload: bytes.slice(HEADER_BYTES)
  }
}

export function decodeTerminalStreamJson<T>(payload: Uint8Array): T | null {
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as T
  } catch {
    return null
  }
}

export function decodeTerminalStreamText(payload: Uint8Array): string {
  return new TextDecoder().decode(payload)
}

function isTerminalStreamOpcode(value: number): value is TerminalStreamOpcode {
  return (
    value === TerminalStreamOpcode.Output ||
    value === TerminalStreamOpcode.SnapshotStart ||
    value === TerminalStreamOpcode.SnapshotChunk ||
    value === TerminalStreamOpcode.SnapshotEnd ||
    value === TerminalStreamOpcode.Resized ||
    value === TerminalStreamOpcode.Error
  )
}
