import { createReadStream } from 'node:fs'
import Assembler from 'stream-json/assembler.js'
import { createJsonTokenReader } from '../../../shared/json-stream/json-token-reader'
import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../../../shared/json-stream/node-bounded-json-stringify'

const TEXT_BATCH_CHARS = 64 * 1024
const STRING_SLICE_CHARS = 4 * 1024

function prepareValue(value: unknown, key: string): unknown {
  if (value !== null && typeof value === 'object') {
    if ('toJSON' in value && typeof value.toJSON === 'function') {
      value = value.toJSON(key)
    }
    const tag = Object.prototype.toString.call(value)
    if (
      value !== null &&
      typeof value === 'object' &&
      (tag === '[object Number]' || tag === '[object String]' || tag === '[object Boolean]')
    ) {
      return value.valueOf()
    }
  }
  return value
}

function omitted(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol'
}

function* encodeString(value: string): Generator<string> {
  if (value.length <= STRING_SLICE_CHARS) {
    yield JSON.stringify(value)
    return
  }
  yield '"'
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + STRING_SLICE_CHARS, value.length)
    const last = value.charCodeAt(end - 1)
    const next = value.charCodeAt(end)
    // Each piece is encoded independently by both file writes and integrity hashes.
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      end--
    }
    yield JSON.stringify(value.slice(offset, end)).slice(1, -1)
    offset = end
  }
  yield '"'
}

function* encodeValue(
  value: unknown,
  ancestors: Set<object>,
  nativeRecord = false
): Generator<string> {
  if (typeof value === 'string') {
    yield* encodeString(value)
    return
  }
  if (value === null || typeof value !== 'object') {
    const text = JSON.stringify(value)
    if (text === undefined) {
      throw new TypeError('Usage cache value is not JSON serializable')
    }
    yield text
    return
  }
  if (ancestors.has(value)) {
    throw new TypeError('Usage cache contains a circular value')
  }
  if (nativeRecord) {
    try {
      yield stringifyJsonWithinByteLimit(value, 256 * 1024).serialized
      return
    } catch (error) {
      if (!(error instanceof JsonStringifyByteLimitError)) {
        throw error
      }
    }
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      yield '['
      for (let index = 0; index < value.length; index++) {
        if (index > 0) {
          yield ','
        }
        const item = prepareValue(value[index], String(index))
        yield* encodeValue(omitted(item) ? null : item, ancestors, true)
      }
      yield ']'
    } else {
      yield '{'
      let first = true
      for (const [key, raw] of Object.entries(value)) {
        const item = prepareValue(raw, key)
        if (omitted(item)) {
          continue
        }
        if (!first) {
          yield ','
        }
        first = false
        yield* encodeString(key)
        yield ':'
        yield* encodeValue(item, ancestors)
      }
      yield '}'
    }
  } finally {
    ancestors.delete(value)
  }
}

/** Batch traversal output without materializing a whole source, string or document. */
export function* encodeUsageCacheJson(value: unknown): Generator<string> {
  let parts: string[] = []
  let length = 0
  for (const part of encodeValue(prepareValue(value, ''), new Set())) {
    if (length + part.length > TEXT_BATCH_CHARS && length > 0) {
      yield parts.join('')
      parts = []
      length = 0
    }
    parts.push(part)
    length += part.length
  }
  if (length > 0) {
    yield parts.join('')
  }
}

/** EOF validation precedes exposing any of the privately assembled records. */
export async function readUsageCacheJson<T>(path: string): Promise<T | null> {
  const assembler = new Assembler<T>()
  const reader = createJsonTokenReader((token) => assembler.consume(token))
  for await (const text of createReadStream(path, {
    encoding: 'utf8',
    highWaterMark: TEXT_BATCH_CHARS
  })) {
    reader.write(text)
  }
  reader.end()
  return assembler.current
}
