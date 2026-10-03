import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { StringDecoder } from 'node:string_decoder'
import {
  JsonTextStructureCapacityError,
  JsonTextStructureValidator,
  type JsonTextStructureLimits
} from '../../shared/json-text-structure-limit'
import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../../shared/node-bounded-json-stringify'
import type { PersistedSessionParseCacheEntry } from './session-parse-cache-store'

export const SESSION_PARSE_CACHE_SCHEMA_VERSION = 3
export const SESSION_PARSE_CACHE_MAX_BYTES = 64 * 1024 * 1024
export const SESSION_PARSE_CACHE_JSON_LIMITS = {
  structuralTokens: 1_000_000,
  nestingDepth: 32
} as const

const TEXT_CHUNK_CHARACTERS = 16 * 1024
const VALIDATE_CHUNK_CHARACTERS = 256 * 1024
const SERIALIZE_YIELD_STEPS = 1024
type CacheEntry = [string, PersistedSessionParseCacheEntry]
type JsonPiece = { text: string; tokens: number }
type CacheJsonObject = Record<string, unknown>

function isCacheJsonObject(value: unknown): value is CacheJsonObject {
  return typeof value === 'object' && value !== null
}

export async function assertSessionParseCacheJsonWithinLimitsCooperatively(
  content: string | Buffer,
  limits: JsonTextStructureLimits = SESSION_PARSE_CACHE_JSON_LIMITS
): Promise<void> {
  const validator = new JsonTextStructureValidator(limits)
  const decoder = new StringDecoder('utf8')
  for (let start = 0; start < content.length; start += VALIDATE_CHUNK_CHARACTERS) {
    const chunk = content.slice(start, start + VALIDATE_CHUNK_CHARACTERS)
    validator.consume(typeof chunk === 'string' ? chunk : decoder.write(chunk))
    if (start + VALIDATE_CHUNK_CHARACTERS < content.length) {
      await yieldToEventLoop()
    }
  }
  validator.consume(decoder.end())
}

/** Retain the newest complete suffix; a newest row that cannot fit preserves the prior file. */
export async function serializeSessionParseCacheSnapshotPiecesCooperatively(
  entries: readonly CacheEntry[],
  appVersion: string,
  maxBytes = SESSION_PARSE_CACHE_MAX_BYTES,
  limits: JsonTextStructureLimits = SESSION_PARSE_CACHE_JSON_LIMITS
): Promise<{ pieces: string[]; byteLength: number; retainedEntries: number } | null> {
  const header = stringifyJsonWithinByteLimit(
    { schemaVersion: SESSION_PARSE_CACHE_SCHEMA_VERSION, appVersion, entries: [] },
    maxBytes
  ).serialized
  const outer = new JsonTextStructureValidator(limits)
  outer.consume(header)
  let byteLength = Buffer.byteLength(header)
  let tokens = outer.usage().structuralTokens
  const rows: string[][] = []
  for (let index = entries.length - 1; index >= 0; index--) {
    const comma = rows.length === 0 ? 0 : 1
    try {
      const row = await serializeCacheRow(entries[index], maxBytes - byteLength - comma, {
        structuralTokens: limits.structuralTokens - tokens - comma,
        nestingDepth: limits.nestingDepth - 2
      })
      rows.push(row.pieces)
      byteLength += row.byteLength + comma
      tokens += row.tokens + comma
    } catch (error) {
      if (
        !(
          error instanceof JsonStringifyByteLimitError ||
          error instanceof JsonTextStructureCapacityError
        )
      ) {
        throw error
      }
      break
    }
    if (rows.length % 16 === 0) {
      await yieldToEventLoop()
    }
  }
  if (entries.length > 0 && rows.length === 0) {
    return null
  }
  const pieces = [header.slice(0, -2)]
  for (let index = rows.length - 1; index >= 0; index--) {
    if (index < rows.length - 1) {
      pieces.push(',')
    }
    pieces.push(...rows[index]!)
  }
  pieces.push(']}')
  return { pieces, byteLength, retainedEntries: rows.length }
}

async function serializeCacheRow(
  value: unknown,
  maxBytes: number,
  limits: JsonTextStructureLimits
) {
  const pieces: string[] = []
  let block = ''
  let byteLength = 0
  let tokens = 0
  let steps = 0
  for (const piece of cacheJsonPieces(value, 0, limits.nestingDepth, new Set())) {
    byteLength += Buffer.byteLength(piece.text)
    tokens += piece.tokens
    if (byteLength > maxBytes) {
      throw new JsonStringifyByteLimitError(byteLength, maxBytes)
    }
    if (tokens > limits.structuralTokens) {
      throw new JsonTextStructureCapacityError('structuralTokens', limits.structuralTokens)
    }
    block += piece.text
    if (block.length >= TEXT_CHUNK_CHARACTERS) {
      pieces.push(block)
      block = ''
    }
    // Large strings and wide objects both yield, including omitted properties.
    if (++steps % SERIALIZE_YIELD_STEPS === 0 || piece.text.length >= TEXT_CHUNK_CHARACTERS / 2) {
      await yieldToEventLoop()
    }
  }
  if (block) {
    pieces.push(block)
  }
  return { pieces, byteLength, tokens }
}

// Native encoding allocates at most six bytes per character of a bounded string chunk.
function* cacheJsonPieces(
  value: unknown,
  depth: number,
  maxDepth: number,
  ancestors: Set<object>
): Generator<JsonPiece> {
  if (typeof value === 'string') {
    yield { text: '"', tokens: 0 }
    for (let start = 0; start < value.length;) {
      let end = Math.min(value.length, start + TEXT_CHUNK_CHARACTERS)
      const last = value.charCodeAt(end - 1)
      if (end < value.length && last >= 0xd800 && last <= 0xdbff) {
        end--
      }
      const serialized = JSON.stringify(value.slice(start, end))
      yield { text: serialized.slice(1, -1), tokens: 0 }
      start = end
    }
    yield { text: '"', tokens: 0 }
    return
  }
  if (!isCacheJsonObject(value)) {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) {
      throw new TypeError('Session parse cache value is not serializable')
    }
    yield { text: serialized, tokens: 0 }
    return
  }
  if (depth + 1 > maxDepth) {
    throw new JsonTextStructureCapacityError('nestingDepth', maxDepth)
  }
  if (ancestors.has(value)) {
    throw new TypeError('Circular session parse cache row')
  }
  ancestors.add(value)
  let count = 0
  if (Array.isArray(value)) {
    yield { text: '[', tokens: 1 }
    for (const item of value) {
      if (count++) {
        yield { text: ',', tokens: 1 }
      }
      yield* cacheJsonPieces(item === undefined ? null : item, depth + 1, maxDepth, ancestors)
    }
    yield { text: ']', tokens: 1 }
  } else {
    yield { text: '{', tokens: 1 }
    for (const key in value) {
      if (!Object.hasOwn(value, key)) {
        continue
      }
      const item: unknown = value[key]
      if (item === undefined) {
        yield { text: '', tokens: 0 }
        continue
      }
      if (count++) {
        yield { text: ',', tokens: 1 }
      }
      yield* cacheJsonPieces(key, depth + 1, maxDepth, ancestors)
      yield { text: ':', tokens: 1 }
      yield* cacheJsonPieces(item, depth + 1, maxDepth, ancestors)
    }
    yield { text: '}', tokens: 1 }
  }
  ancestors.delete(value)
}
