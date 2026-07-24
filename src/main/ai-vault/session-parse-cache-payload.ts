import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../../shared/node-bounded-json-stringify'
import type { PersistedSessionParseCacheEntry } from './session-parse-cache-retention'

// Half the loader's 64 MiB ceiling leaves headroom for the UTF-16 string and
// the writeFile encoding buffer to coexist during a save.
export const AI_VAULT_PARSE_CACHE_PERSIST_MAX_UTF8_BYTES = 32 * 1024 * 1024
export const AI_VAULT_PARSE_CACHE_APP_VERSION_MAX_JSON_BYTES = 4 * 1024

export function serializeSessionParseCachePayload(args: {
  schemaVersion: number
  appVersion: string
  entries: readonly [string, PersistedSessionParseCacheEntry][]
  maxBytes?: number
}): string {
  if (!Number.isSafeInteger(args.schemaVersion)) {
    throw new TypeError('Session parse cache schema version must be a safe integer')
  }
  const maxBytes = boundedPayloadLimit(args.maxBytes)
  const appVersion = stringifyJsonWithinByteLimit(
    args.appVersion,
    AI_VAULT_PARSE_CACHE_APP_VERSION_MAX_JSON_BYTES
  ).serialized
  const prefix = `{"schemaVersion":${args.schemaVersion},"appVersion":${appVersion},"entries":[`
  const suffix = ']}'
  let retainedBytes = Buffer.byteLength(prefix, 'utf8') + Buffer.byteLength(suffix, 'utf8')
  if (retainedBytes > maxBytes) {
    throw new JsonStringifyByteLimitError(retainedBytes, maxBytes)
  }

  const newestFirst: string[] = []
  for (let index = args.entries.length - 1; index >= 0; index -= 1) {
    const separatorBytes = newestFirst.length === 0 ? 0 : 1
    const remaining = maxBytes - retainedBytes - separatorBytes
    if (remaining < 0) {
      continue
    }
    try {
      const encoded = stringifyJsonWithinByteLimit(args.entries[index], remaining)
      newestFirst.push(encoded.serialized)
      retainedBytes += separatorBytes + encoded.byteLength
    } catch {
      // One entry that cannot fit must not prevent smaller older entries from persisting.
    }
  }

  const fragments = [prefix]
  for (let index = newestFirst.length - 1; index >= 0; index -= 1) {
    if (index < newestFirst.length - 1) {
      fragments.push(',')
    }
    fragments.push(newestFirst[index])
  }
  fragments.push(suffix)
  return fragments.join('')
}

function boundedPayloadLimit(requested: number | undefined): number {
  const limit = requested ?? AI_VAULT_PARSE_CACHE_PERSIST_MAX_UTF8_BYTES
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError('Session parse cache payload limit must be a non-negative safe integer')
  }
  return Math.min(limit, AI_VAULT_PARSE_CACHE_PERSIST_MAX_UTF8_BYTES)
}
