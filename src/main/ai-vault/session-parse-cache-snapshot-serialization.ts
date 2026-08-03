import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import {
  JsonTextStructureCapacityError,
  JsonTextStructureValidator,
  type JsonTextStructureLimits
} from '../../shared/json-text-structure-limit'
import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../../shared/node-bounded-json-stringify'
import type { PersistedSessionParseCacheEntry } from './session-scanner-parse-cache'

export const SESSION_PARSE_CACHE_SCHEMA_VERSION = 1
export const SESSION_PARSE_CACHE_MAX_BYTES = 64 * 1024 * 1024
export const SESSION_PARSE_CACHE_JSON_LIMITS = {
  structuralTokens: 1_000_000,
  nestingDepth: 32
} as const

const SNAPSHOT_OUTER_STRUCTURAL_TOKENS = 9
const SNAPSHOT_ENTRY_DEPTH_OFFSET = 2
const SERIALIZE_YIELD_EVERY_ENTRIES = 16
const VALIDATE_YIELD_EVERY_CHARACTERS = 256 * 1024

type CacheEntry = [string, PersistedSessionParseCacheEntry]
export type SerializedSessionParseCacheSnapshot = Readonly<{
  pieces: readonly string[]
  byteLength: number
}>

export function serializeSessionParseCacheSnapshot(
  entries: CacheEntry[],
  appVersion: string,
  maxBytes: number = SESSION_PARSE_CACHE_MAX_BYTES,
  jsonLimits: JsonTextStructureLimits = SESSION_PARSE_CACHE_JSON_LIMITS
): string | null {
  return retainMaximumFittingSuffix(
    entries,
    (retained) => serializeSnapshotAttempt(retained, appVersion, maxBytes, jsonLimits),
    logRetainedEntries
  )
}

export async function serializeSessionParseCacheSnapshotCooperatively(
  entries: CacheEntry[],
  appVersion: string,
  maxBytes: number = SESSION_PARSE_CACHE_MAX_BYTES,
  jsonLimits: JsonTextStructureLimits = SESSION_PARSE_CACHE_JSON_LIMITS
): Promise<string | null> {
  const snapshot = await serializeSessionParseCacheSnapshotPiecesCooperatively(
    entries,
    appVersion,
    maxBytes,
    jsonLimits
  )
  return snapshot ? snapshot.pieces.join('') : null
}

export function serializeSessionParseCacheSnapshotPiecesCooperatively(
  entries: CacheEntry[],
  appVersion: string,
  maxBytes: number = SESSION_PARSE_CACHE_MAX_BYTES,
  jsonLimits: JsonTextStructureLimits = SESSION_PARSE_CACHE_JSON_LIMITS
): Promise<SerializedSessionParseCacheSnapshot | null> {
  return retainMaximumFittingSuffixAsync(
    entries,
    (retained) => serializeSnapshotAttemptCooperatively(retained, appVersion, maxBytes, jsonLimits),
    logRetainedEntries
  )
}

export async function assertSessionParseCacheJsonWithinLimitsCooperatively(
  content: string,
  limits: JsonTextStructureLimits
): Promise<void> {
  const validator = new JsonTextStructureValidator(limits)
  for (let start = 0; start < content.length; start += VALIDATE_YIELD_EVERY_CHARACTERS) {
    const end = Math.min(content.length, start + VALIDATE_YIELD_EVERY_CHARACTERS)
    validator.consume(content, start, end)
    if (end < content.length) {
      await yieldToEventLoop()
    }
  }
}

function serializeSnapshotAttempt(
  entries: CacheEntry[],
  appVersion: string,
  maxBytes: number,
  jsonLimits: JsonTextStructureLimits
): string {
  const { serialized } = stringifyJsonWithinByteLimit(
    {
      schemaVersion: SESSION_PARSE_CACHE_SCHEMA_VERSION,
      appVersion,
      entries
    },
    maxBytes
  )
  new JsonTextStructureValidator(jsonLimits).consume(serialized)
  return serialized
}

async function serializeSnapshotAttemptCooperatively(
  entries: CacheEntry[],
  appVersion: string,
  maxBytes: number,
  jsonLimits: JsonTextStructureLimits
): Promise<SerializedSessionParseCacheSnapshot> {
  assertOuterStructureFits(entries.length, jsonLimits)
  const prefix = `{"schemaVersion":${SESSION_PARSE_CACHE_SCHEMA_VERSION},"appVersion":${JSON.stringify(appVersion)},"entries":[`
  const suffix = ']}'
  const commaBytes = Math.max(0, entries.length - 1)
  let byteLength = Buffer.byteLength(prefix) + Buffer.byteLength(suffix) + commaBytes
  if (byteLength > maxBytes) {
    throw new JsonStringifyByteLimitError(byteLength, maxBytes)
  }
  let structuralTokens = SNAPSHOT_OUTER_STRUCTURAL_TOKENS + commaBytes
  const pieces = [prefix]

  for (let index = 0; index < entries.length; index += 1) {
    const { serialized, byteLength: entryBytes } = stringifyJsonWithinByteLimit(
      entries[index],
      maxBytes - byteLength
    )
    const remainingStructuralTokens = jsonLimits.structuralTokens - structuralTokens
    const validator = new JsonTextStructureValidator({
      structuralTokens: remainingStructuralTokens,
      nestingDepth: jsonLimits.nestingDepth - SNAPSHOT_ENTRY_DEPTH_OFFSET
    })
    validator.consume(serialized)
    structuralTokens += validator.usage().structuralTokens
    byteLength += entryBytes
    if (index > 0) {
      pieces.push(',')
    }
    pieces.push(serialized)
    if ((index + 1) % SERIALIZE_YIELD_EVERY_ENTRIES === 0 && index + 1 < entries.length) {
      await yieldToEventLoop()
    }
  }
  pieces.push(suffix)
  return { pieces, byteLength }
}

function assertOuterStructureFits(entryCount: number, limits: JsonTextStructureLimits): void {
  if (limits.nestingDepth < SNAPSHOT_ENTRY_DEPTH_OFFSET) {
    throw new JsonTextStructureCapacityError('nestingDepth', limits.nestingDepth)
  }
  const structuralTokens = SNAPSHOT_OUTER_STRUCTURAL_TOKENS + Math.max(0, entryCount - 1)
  if (structuralTokens > limits.structuralTokens) {
    throw new JsonTextStructureCapacityError('structuralTokens', limits.structuralTokens)
  }
}

function retainMaximumFittingSuffix(
  entries: CacheEntry[],
  serialize: (retained: CacheEntry[]) => string,
  onRetained: (retained: number, total: number) => void
): string | null {
  if (entries.length === 0) {
    return null
  }
  try {
    return serialize(entries)
  } catch (error) {
    if (!isCapacityError(error)) {
      throw error
    }
  }

  let low = 1
  let high = entries.length - 1
  let best: { serialized: string; start: number } | null = null
  while (low <= high) {
    const start = Math.floor((low + high) / 2)
    try {
      best = { serialized: serialize(entries.slice(start)), start }
      high = start - 1
    } catch (error) {
      if (!isCapacityError(error)) {
        throw error
      }
      low = start + 1
    }
  }
  if (!best) {
    logNoFittingEntries()
    return null
  }
  onRetained(entries.length - best.start, entries.length)
  return best.serialized
}

async function retainMaximumFittingSuffixAsync<Value>(
  entries: CacheEntry[],
  serialize: (retained: CacheEntry[]) => Promise<Value>,
  onRetained: (retained: number, total: number) => void
): Promise<Value | null> {
  if (entries.length === 0) {
    return null
  }
  try {
    return await serialize(entries)
  } catch (error) {
    if (!isCapacityError(error)) {
      throw error
    }
  }

  let low = 1
  let high = entries.length - 1
  let best: { serialized: Value; start: number } | null = null
  while (low <= high) {
    const start = Math.floor((low + high) / 2)
    try {
      best = { serialized: await serialize(entries.slice(start)), start }
      high = start - 1
    } catch (error) {
      if (!isCapacityError(error)) {
        throw error
      }
      low = start + 1
    }
  }
  if (!best) {
    logNoFittingEntries()
    return null
  }
  onRetained(entries.length - best.start, entries.length)
  return best.serialized
}

function isCapacityError(error: unknown): boolean {
  return (
    error instanceof JsonStringifyByteLimitError || error instanceof JsonTextStructureCapacityError
  )
}

function logRetainedEntries(retained: number, total: number): void {
  console.debug(
    `[ai-vault] session parse cache trimmed to ${retained}/${total} entries to fit its size limits`
  )
}

function logNoFittingEntries(): void {
  console.debug('[ai-vault] session parse cache save skipped: no entry subset fits its size limits')
}
