import { Assembler } from 'stream-json/core/assembler.js'
import { createJsonTokenReader } from '../../shared/json-token-reader'
import { asRecord } from '../ai-vault/session-scanner-values'
import type { TranscriptWork } from './transcript-work-scheduler'

const PARSE_QUANTUM = 64 * 1024
const TRANSCRIPT_FIELDS = new Set([
  'type',
  'id',
  'uuid',
  'sessionId',
  'cwd',
  'timestamp',
  'parentUuid',
  'interruptedMessageId',
  'message',
  'payload',
  'ordinal',
  'toolUseResult',
  'isMeta',
  'isSynthetic',
  'isCompactSummary',
  'attachment',
  'content',
  'role',
  'text',
  'summary',
  'synthetic_reason',
  'tool_calls',
  'kind',
  'name',
  'tool',
  'call_id',
  'action',
  'arguments',
  'input',
  'output',
  'result',
  'is_error',
  'isError',
  'version',
  'parentId',
  'firstKeptEntryIndex',
  'firstKeptEntryId',
  'display'
])

/** Embedded tool arguments are values; only transcript records may omit unused root fields. */
export function* parseTranscriptValueWork(
  text: string,
  transcript = false
): TranscriptWork<unknown> {
  const bytes = Buffer.byteLength(text)
  if (bytes <= PARSE_QUANTUM) {
    const value: unknown = JSON.parse(text)
    yield Math.max(1, Math.ceil(bytes / 256))
    return value
  }
  const assembler = new Assembler()
  let depth = 0
  let rootObject = false
  let selected = true
  const parser = createJsonTokenReader(
    (token) => {
      if (token.name === 'startObject' || token.name === 'startArray') {
        if (depth === 0) {
          rootObject = token.name === 'startObject'
          selected = !transcript || rootObject
        }
        if (depth === 0 || selected) {
          assembler.consume(token)
        }
        depth++
        return
      }
      if (token.name === 'endObject' || token.name === 'endArray') {
        depth--
        if (depth === 0 || selected) {
          assembler.consume(token)
        }
        return
      }
      if (transcript && rootObject && depth === 1 && token.name === 'keyValue') {
        selected = TRANSCRIPT_FIELDS.has(token.value)
      }
      if (selected) {
        assembler.consume(token)
      }
    },
    PARSE_QUANTUM,
    () => selected
  )
  const inputBuffer = Buffer.allocUnsafe(Math.min(text.length, PARSE_QUANTUM) * 2)
  for (let offset = 0; offset < text.length; offset += PARSE_QUANTUM) {
    const chunk = text.slice(offset, offset + PARSE_QUANTUM)
    const written = inputBuffer.write(chunk, 0, chunk.length * 2, 'utf16le')
    // Retained tokens must not keep the complete source line alive.
    parser.write(inputBuffer.toString('utf16le', 0, written))
    yield Math.ceil(chunk.length / 256)
  }
  parser.end()
  return assembler.current
}

export function* parseTranscriptRecordWork(
  text: string
): TranscriptWork<Record<string, unknown> | null> {
  if (!text.trim()) {
    return null
  }
  try {
    return asRecord(yield* parseTranscriptValueWork(text, true))
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }
    throw error
  }
}
