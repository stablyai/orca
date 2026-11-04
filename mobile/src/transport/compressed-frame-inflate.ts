import { gunzipSync } from 'fflate'
import { readCompressedFrame } from '../../../src/shared/paired-e2ee-compressed-frame'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../src/shared/remote-runtime/remote-runtime-memory-limits'
import { pairedE2EENativeCodec } from './paired-e2ee-native-codec'

export type InflatedFrame = { kind: 'text'; text: string } | { kind: 'binary'; bytes: Uint8Array }

/** What a compressed frame carries, or null for any other binary frame; throws on a corrupt one. */
export function inflateCompressedFrame(frame: Uint8Array): InflatedFrame | null {
  const compressed = readCompressedFrame(frame)
  if (!compressed) {
    return null
  }
  const { payloadKind, inflatedByteLength, gzipped } = compressed
  // Why: the desktop never sends a frame above its outbound cap, so a larger claim is a corrupt frame.
  if (inflatedByteLength > REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES) {
    throw new Error(`Compressed frame claims ${inflatedByteLength} bytes`)
  }
  const native = pairedE2EENativeCodec()
  // One byte past the claim lets a member that inflates larger fail the length check, not overrun.
  const bytes = native
    ? native.gunzip(gzipped, inflatedByteLength + 1)
    : gunzipSync(gzipped, { out: new Uint8Array(inflatedByteLength + 1) })
  if (bytes.byteLength !== inflatedByteLength) {
    throw new Error('Compressed frame inflated to an unexpected length')
  }
  if (payloadKind === 'binary') {
    return { kind: 'binary', bytes }
  }
  return { kind: 'text', text: native?.decodeUtf8(bytes) ?? new TextDecoder().decode(bytes) }
}
