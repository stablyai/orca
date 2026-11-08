import { uint32Bytes, utf8Encode, utf8Decode } from './crypto/Bytes';

/**
 * Terminal binary stream frames (src/shared/terminal/stream/terminal-stream-protocol.ts):
 * 16-byte header — kind 0x74, version 1, opcode, 0, streamId u32 LE, seq u64 LE —
 * then an opcode-specific JSON or UTF-8 payload. Desktop→mobile opcodes convert to
 * the same JSON result objects upstream rpc-client-terminal-binary-frame.ts feeds
 * its streaming listeners.
 */

const TERMINAL_STREAM_KIND = 0x74;
const TERMINAL_STREAM_VERSION = 1;
const HEADER_BYTES = 16;

export const OP_OUTPUT = 1;
export const OP_SNAPSHOT_START = 2;
export const OP_SNAPSHOT_CHUNK = 3;
export const OP_SNAPSHOT_END = 4;
export const OP_RESIZED = 5;
export const OP_ERROR = 6;
export const OP_INPUT = 7;
export const OP_RESIZE = 8;
export const OP_SUBSCRIBE = 9;
export const OP_UNSUBSCRIBE = 10;
export const OP_SNAPSHOT_REQUEST = 11;
export const OP_METADATA = 12;
export const OP_ACK = 13;
export const OP_CLAIM_VIEWPORT = 14;
export const OP_OUTPUT_SPAN = 15;

export interface TerminalFrame {
  opcode: number;
  streamId: number;
  payload: Uint8Array;
}

export function isTerminalFrame(bytes: Uint8Array): boolean {
  return bytes.length >= HEADER_BYTES && bytes[0] === TERMINAL_STREAM_KIND
    && bytes[1] === TERMINAL_STREAM_VERSION;
}

export function decodeTerminalFrame(bytes: Uint8Array): TerminalFrame | null {
  if (!isTerminalFrame(bytes)) {
    return null;
  }
  let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let opcode = view.getUint8(2);
  let streamId = view.getUint32(4, true);
  return { opcode: opcode, streamId: streamId, payload: bytes.subarray(HEADER_BYTES) };
}

/** Client→host frame (encodeTerminalStreamFrame): 16-byte header, then payload. */
export function encodeTerminalFrame(opcode: number, streamId: number, seq: number,
  payload: Uint8Array): Uint8Array {
  let out = new Uint8Array(HEADER_BYTES + payload.length);
  let view = new DataView(out.buffer);
  view.setUint8(0, TERMINAL_STREAM_KIND);
  view.setUint8(1, TERMINAL_STREAM_VERSION);
  view.setUint8(2, opcode);
  view.setUint8(3, 0);
  view.setUint32(4, streamId >>> 0, true);
  let bounded = Math.max(0, Math.floor(seq));
  view.setUint32(8, Math.floor(bounded / 0x100000000), true);
  view.setUint32(12, bounded >>> 0, true);
  out.set(payload, HEADER_BYTES);
  return out;
}

/** JSON payload bytes for control frames ({cols, rows}) — upstream encodeTerminalStreamJson. */
export function encodeViewportJson(cols: number, rows: number): Uint8Array {
  let viewport: Record<string, Object> = {
    'cols': cols,
    'rows': rows
  };
  return utf8Encode(JSON.stringify(viewport));
}

export interface TerminalSnapshotState {
  meta: string; // raw JSON text of the SnapshotStart meta object
  chunks: string[];
}

/** Compressed transport frame (paired-e2ee-compressed-frame.ts): kind 0x7a, payloadKind, inflated u32 LE, gzip member. */
export const COMPRESSED_FRAME_KIND = 0x7a;

export interface CompressedFrame {
  payloadKind: number;
  inflatedLength: number;
  gzipped: Uint8Array;
}

export function readCompressedFrame(bytes: Uint8Array): CompressedFrame | null {
  if (bytes.byteLength < 6 || bytes[0] !== COMPRESSED_FRAME_KIND) {
    return null;
  }
  let payloadKind = bytes[1];
  if (payloadKind !== 1 && payloadKind !== 2) {
    return null;
  }
  let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let inflatedLength = view.getUint32(2, true);
  let frame: CompressedFrame = {
    payloadKind: payloadKind,
    inflatedLength: inflatedLength,
    gzipped: bytes.subarray(6)
  };
  return frame;
}

/** Convert one desktop→mobile terminal frame into the streaming result object JSON (upstream shape). */
export function convertTerminalFrame(frame: TerminalFrame,
  snapshots: Map<number, TerminalSnapshotState>): string | null {
  if (frame.opcode === OP_OUTPUT) {
    let result: Record<string, Object> = {
      'type': 'data',
      'streamId': frame.streamId,
      'chunk': utf8Decode(frame.payload)
    };
    return JSON.stringify(result);
  }
  if (frame.opcode === OP_OUTPUT_SPAN) {
    let span: Object | null = null;
    try {
      span = JSON.parse(utf8Decode(frame.payload)) as Object | null;
    } catch (e) {
      return null;
    }
    if (span === null || typeof span !== 'object') {
      return null;
    }
    let rec = span as Record<string, Object>;
    let data: Object = rec['data'];
    if (typeof data !== 'string') {
      return null;
    }
    let result: Record<string, Object> = {
      'type': 'data',
      'streamId': frame.streamId,
      'chunk': data
    };
    return JSON.stringify(result);
  }
  if (frame.opcode === OP_SNAPSHOT_START) {
    let metaText = utf8Decode(frame.payload);
    let state: TerminalSnapshotState = { meta: metaText, chunks: [] };
    snapshots.set(frame.streamId, state);
    return null;
  }
  if (frame.opcode === OP_SNAPSHOT_CHUNK) {
    let state = snapshots.get(frame.streamId);
    if (state === undefined) {
      return null;
    }
    state.chunks.push(utf8Decode(frame.payload));
    return null;
  }
  if (frame.opcode === OP_SNAPSHOT_END) {
    let state = snapshots.get(frame.streamId);
    if (state === undefined) {
      return null;
    }
    snapshots.delete(frame.streamId);
    return assembleSnapshot(state, frame.streamId);
  }
  if (frame.opcode === OP_RESIZED) {
    return mergeMeta(utf8Decode(frame.payload), 'resized', frame.streamId);
  }
  if (frame.opcode === OP_METADATA) {
    return mergeMeta(utf8Decode(frame.payload), 'metadata', frame.streamId);
  }
  if (frame.opcode === OP_ERROR) {
    let result: Record<string, Object> = {
      'type': 'error',
      'streamId': frame.streamId,
      'message': utf8Decode(frame.payload)
    };
    return JSON.stringify(result);
  }
  return null;
}

function assembleSnapshot(state: TerminalSnapshotState, streamId: number): string | null {
  let metaText = state.meta;
  let metaObj: Object | null = null;
  try {
    metaObj = JSON.parse(metaText) as Object | null;
  } catch (e) {
    metaObj = null;
  }
  let kind = 'scrollback';
  if (metaObj !== null && typeof metaObj === 'object') {
    let rec = metaObj as Record<string, Object>;
    if (rec['kind'] === 'resized') {
      kind = 'resized';
    }
  }
  let base: Record<string, Object> = {};
  if (metaObj !== null && typeof metaObj === 'object') {
    let rec = metaObj as Record<string, Object>;
    let keys = Object.keys(rec);
    for (let i = 0; i < keys.length; i++) {
      base[keys[i]] = rec[keys[i]];
    }
  }
  base['type'] = kind;
  base['streamId'] = streamId;
  base['serialized'] = state.chunks.join('');
  return JSON.stringify(base);
}

function mergeMeta(metaText: string, type: string, streamId: number): string | null {
  let metaObj: Object | null = null;
  try {
    metaObj = JSON.parse(metaText) as Object | null;
  } catch (e) {
    return null;
  }
  let base: Record<string, Object> = {};
  if (metaObj !== null && typeof metaObj === 'object') {
    let rec = metaObj as Record<string, Object>;
    let keys = Object.keys(rec);
    for (let i = 0; i < keys.length; i++) {
      base[keys[i]] = rec[keys[i]];
    }
  }
  base['type'] = type;
  base['streamId'] = streamId;
  return JSON.stringify(base);
}
