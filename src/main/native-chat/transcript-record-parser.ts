import { Assembler } from 'stream-json/core/assembler.js'
import type { Token } from 'stream-json/core/parser.js'
import { createJsonTokenReader } from '../../shared/json-token-reader'
import { asRecord } from '../ai-vault/session-scanner-record-value'
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

type ClaudeContainer = 'root' | 'message' | 'attachment' | 'content' | 'block' | 'source' | 'opaque'

/** Direct content-block source.data is unused; arbitrary nested tool values remain whole. */
function createClaudeRecordSelection() {
  const containers: ClaudeContainer[] = []
  const selections: boolean[] = []
  let key = ''
  let selected = true
  let opaqueDepth = 0
  return {
    retainScalar: () => selected,
    accept(token: Token): boolean {
      if (opaqueDepth > 0) {
        const accepted = selected
        if (token.name === 'startObject' || token.name === 'startArray') {
          opaqueDepth++
        } else if (token.name === 'endObject' || token.name === 'endArray') {
          if (--opaqueDepth === 0) {
            selected = selections.at(-1) ?? true
            return containers.length === 0 || accepted
          }
        }
        return accepted
      }
      if (token.name === 'startObject' || token.name === 'startArray') {
        const root = containers.length === 0
        const parent = containers.at(-1)
        let container: ClaudeContainer = 'opaque'
        if (token.name === 'startObject') {
          if (root) {
            container = 'root'
          } else if (parent === 'root' && key === 'message') {
            container = 'message'
          } else if (parent === 'root' && key === 'attachment') {
            container = 'attachment'
          } else if (parent === 'content') {
            container = 'block'
          } else if (parent === 'block' && key === 'source') {
            container = 'source'
          }
        } else if (
          (parent === 'message' && key === 'content') ||
          (parent === 'attachment' && key === 'prompt')
        ) {
          container = 'content'
        }
        if (root) {
          selected = token.name === 'startObject'
        }
        if (!selected || container === 'opaque') {
          opaqueDepth = 1
        } else {
          containers.push(container)
          selections.push(selected)
        }
        return root || selected
      }
      if (token.name === 'endObject' || token.name === 'endArray') {
        const accepted = selections.pop() ?? true
        containers.pop()
        selected = selections.at(-1) ?? true
        return containers.length === 0 || accepted
      }
      if (token.name === 'keyValue') {
        key = token.value
        const container = containers.at(-1)
        selected = selections.at(-1) ?? true
        if (container === 'root') {
          selected &&= TRANSCRIPT_FIELDS.has(key)
        } else if (container === 'source' && key === 'data') {
          selected = false
        }
        return selected
      }
      const accepted = selected
      selected = selections.at(-1) ?? true
      return accepted
    }
  }
}

/** Embedded tool arguments are whole values; transcript records may omit unused fields. */
export function* parseTranscriptValueWork(
  text: string,
  context: 'value' | 'record' | 'claude' = 'value'
): TranscriptWork<unknown> {
  const bytes = Buffer.byteLength(text)
  if (bytes <= PARSE_QUANTUM) {
    const value: unknown = JSON.parse(text)
    yield Math.max(1, Math.ceil(bytes / 256))
    return value
  }
  const assembler = new Assembler()
  const claude = context === 'claude' ? createClaudeRecordSelection() : null
  let depth = 0
  let rootObject = false
  let selected = true
  const parser = createJsonTokenReader(
    claude
      ? (token) => {
          if (claude.accept(token)) {
            assembler.consume(token)
          }
        }
      : (token) => {
          if (token.name === 'startObject' || token.name === 'startArray') {
            if (depth === 0) {
              rootObject = token.name === 'startObject'
              selected = context === 'value' || rootObject
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
          if (context !== 'value' && rootObject && depth === 1 && token.name === 'keyValue') {
            selected = TRANSCRIPT_FIELDS.has(token.value)
          }
          if (selected) {
            assembler.consume(token)
          }
        },
    PARSE_QUANTUM,
    claude?.retainScalar ?? (() => selected)
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
  text: string,
  claude = false
): TranscriptWork<Record<string, unknown> | null> {
  if (!text.trim()) {
    return null
  }
  try {
    return asRecord(yield* parseTranscriptValueWork(text, claude ? 'claude' : 'record'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }
    throw error
  }
}
