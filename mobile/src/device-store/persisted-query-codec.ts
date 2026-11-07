import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate'
import { decodeBase64Bytes, encodeBase64Bytes } from '../transport/base64-byte-codec'

// Store values are base64(gzip(JSON)) in both tables: the shell seals the bytes the base64 names.
export function encodeDeviceStoreValue(value: unknown): string {
  return encodeBase64Bytes(gzipSync(strToU8(JSON.stringify(value))))
}

/** Undefined when the value fails to decode or parse; such a value is never shown. */
export function decodeDeviceStoreValue(raw: string): unknown {
  try {
    return JSON.parse(strFromU8(gunzipSync(decodeBase64Bytes(raw))))
  } catch {
    return undefined
  }
}
