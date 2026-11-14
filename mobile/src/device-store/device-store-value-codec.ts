import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate'
import { decodeBase64Bytes, encodeBase64Bytes } from '../transport/encryption/base64-byte-codec'

// Encoded length (base64 of gzipped JSON), about 3-5 MB of JSON; writers trim or skip larger values.
// Lives here, not in the store module, so a page can check it without importing the store.
export const DEVICE_STORE_MAX_VALUE_LENGTH = 512 * 1024

// Store values are base64(gzip(JSON)) in both tables: the store seals the bytes the base64 names.
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
