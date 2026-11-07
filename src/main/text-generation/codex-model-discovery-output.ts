import { StringDecoder } from 'node:string_decoder'
import { FlexAssembler, objectRule, arrayRule } from 'stream-json/core/utils/flex-assembler.js'
import { createJsonTokenReader } from '../../shared/json-token-reader'

const MAX_CATALOG_BYTES = 64 * 1024 * 1024
const MODEL_FIELDS = new Set([
  'slug',
  'display_name',
  'supported_reasoning_levels',
  'default_reasoning_level',
  'visibility'
])

/** Discard prompt templates before applying the normal model-output budget. */
export function createCodexModelDiscoveryOutput(maxBytes: number): {
  write: (chunk: Buffer) => void
  end: () => string
  readonly bytes: number
} {
  const decoder = new StringDecoder('utf8')
  const record: Record<string, unknown> = {}
  let inputBytes = 0
  let bytes = 0
  let prefix = ''
  let plain = ''
  let json: boolean | undefined
  let malformed = false
  const retain = (path: (string | number)[]): boolean =>
    path.length === 0 ||
    (path[0] === 'models' &&
      (path.length <= 2 || (typeof path[2] === 'string' && MODEL_FIELDS.has(path[2]))))
  const discarded = {
    filter: (path: (string | number)[]) => !retain(path),
    create: () => null,
    add: () => {}
  }
  const assembler = new FlexAssembler({
    maxDepth: 16,
    objectRules: [
      objectRule<Record<string, unknown>>({
        filter: (path) => path.length === 0,
        create: () => record,
        add: (target, key, value) => {
          if (key === 'models') {
            target[key] = value
          }
        }
      }),
      objectRule<Record<string, unknown>>({
        filter: (path) => path.length === 2 && path[0] === 'models',
        create: () => ({}),
        add: (target, key, value) => {
          if (MODEL_FIELDS.has(key)) {
            target[key] = value
          }
        }
      }),
      objectRule(discarded)
    ],
    arrayRules: [arrayRule(discarded)]
  })
  const nextPath = (): (string | number)[] => {
    const key = assembler.isArray ? assembler.arrayIndex + 1 : assembler.key
    return key === null ? assembler.path : [...assembler.path, key]
  }
  const parser = createJsonTokenReader(
    (token) => {
      const path = token.name === 'keyValue' ? [...assembler.path, token.value] : nextPath()
      if (retain(path)) {
        bytes += ('value' in token ? Buffer.byteLength(JSON.stringify(token.value)) : 0) + 2
        if (bytes > maxBytes) {
          throw new RangeError('Codex model metadata exceeds the size limit')
        }
      }
      assembler.consume(token)
    },
    64 * 1024,
    () => retain(nextPath()),
    maxBytes
  )
  const parse = (text: string): void => {
    if (malformed) {
      return
    }
    try {
      parser.write(text)
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error
      }
      malformed = true
    }
  }
  return {
    get bytes() {
      return bytes
    },
    write(chunk) {
      inputBytes += chunk.byteLength
      if (inputBytes > MAX_CATALOG_BYTES) {
        throw new RangeError('Codex catalog exceeds the size limit')
      }
      const text = decoder.write(chunk)
      if (prefix.length < 4096) {
        prefix += text.slice(0, 4096 - prefix.length)
      }
      if (json === undefined && text.trimStart()) {
        json = text.trimStart().startsWith('{')
      }
      if (json) {
        parse(text)
      } else {
        bytes += chunk.byteLength
        if (bytes > maxBytes) {
          throw new RangeError('Codex model output exceeds the size limit')
        }
        plain += text
      }
    },
    end() {
      const tail = decoder.end()
      if (!json) {
        return plain + tail
      }
      if (tail) {
        parse(tail)
      }
      if (!malformed) {
        try {
          parser.end()
        } catch (error) {
          if (!(error instanceof SyntaxError)) {
            throw error
          }
          malformed = true
        }
      }
      if (malformed) {
        return ''
      }
      if (!Array.isArray(record.models)) {
        return prefix
      }
      const result = JSON.stringify(record)
      if (Buffer.byteLength(result) > maxBytes) {
        throw new RangeError('Codex model metadata exceeds the size limit')
      }
      return result
    }
  }
}
