import type { PersistedQuery } from '@tanstack/query-persist-client-core'
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate'
import { decodeBase64Bytes, encodeBase64Bytes } from '../transport/base64-byte-codec'

// The store's per-value cap (DEVICE_STORE_MAX_VALUE_LENGTH), restated because a page can't import the store module.
export const PERSISTED_QUERY_MAX_ENCODED_LENGTH = 512 * 1024

// base64(gzip(JSON)): the store seals the bytes the base64 stands for.
export function encodePersistedQuery(query: PersistedQuery): string {
  return encodeBase64Bytes(gzipSync(strToU8(JSON.stringify(query))))
}

// Throws on a value it can't read, which TanStack answers by removing the row.
export function decodePersistedQuery(value: string): PersistedQuery {
  return JSON.parse(strFromU8(gunzipSync(decodeBase64Bytes(value))))
}
