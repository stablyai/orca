import { assertJsonTextStructureWithinLimits } from '../../shared/json-text-structure-limit'
import { GrowingByteBuffer } from '../../shared/growing-byte-buffer'
import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'

export function encodeNdjson(msg: unknown): string {
  return `${JSON.stringify(msg)}\n`
}

export function encodeBoundedNdjson(msg: unknown, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('NDJSON byte limit must be a positive safe integer')
  }
  return `${stringifyJsonWithinByteLimit(msg, maxBytes - 1).serialized}\n`
}

export const NDJSON_MAX_LINE_BYTES = 16 * 1024 * 1024
export const DAEMON_HANDSHAKE_MAX_LINE_BYTES = 64 * 1024
export const NDJSON_MAX_STRUCTURAL_TOKENS = 1_000_000
export const NDJSON_MAX_NESTING_DEPTH = 128

export type NdjsonParser = {
  feed(chunk: string): void
  reset(): void
}

export type NdjsonParserOptions = {
  maxLineBytes?: number
  includeLineBytes?: boolean
}

export function createNdjsonParser(
  onMessage: (msg: unknown, lineBytes?: number) => void,
  onError?: (err: Error) => void,
  options: NdjsonParserOptions = {}
): NdjsonParser {
  const buffer = new GrowingByteBuffer()
  let discardingOversizedLine = false
  const maxLineBytes = Math.max(1, options.maxLineBytes ?? NDJSON_MAX_LINE_BYTES)

  const clearBuffer = (): void => {
    buffer.clear()
  }

  const reportOversizedLine = (observedBytes: number): void => {
    onError?.(
      new Error(`NDJSON line exceeds max ${maxLineBytes} bytes (${observedBytes} bytes received)`)
    )
  }

  return {
    feed(chunk: string): void {
      let remaining = chunk

      while (remaining.length > 0) {
        const newlineIndex = remaining.indexOf('\n')
        const hasNewline = newlineIndex !== -1
        const segment = hasNewline ? remaining.slice(0, newlineIndex) : remaining
        remaining = hasNewline ? remaining.slice(newlineIndex + 1) : ''

        if (discardingOversizedLine) {
          if (hasNewline) {
            discardingOversizedLine = false
            clearBuffer()
            continue
          }
          return
        }

        const segmentBytes = Buffer.from(segment, 'utf8')
        const nextLineBytes = buffer.byteLength + segmentBytes.byteLength
        // Why: daemon sockets are local but persistent; a peer that never sends
        // a newline must not grow the parser buffer without bound.
        if (nextLineBytes > maxLineBytes) {
          reportOversizedLine(nextLineBytes)
          clearBuffer()
          if (!hasNewline) {
            discardingOversizedLine = true
            return
          }
          continue
        }

        buffer.append(segmentBytes)
        if (!hasNewline) {
          return
        }

        const lineBytes = buffer.byteLength
        const line = buffer.takeString('utf8')

        if (line.length === 0) {
          continue
        }

        try {
          assertJsonTextStructureWithinLimits(line, {
            structuralTokens: NDJSON_MAX_STRUCTURAL_TOKENS,
            nestingDepth: NDJSON_MAX_NESTING_DEPTH
          })
          const parsed = JSON.parse(line)
          if (options.includeLineBytes) {
            onMessage(parsed, lineBytes)
          } else {
            onMessage(parsed)
          }
        } catch (err) {
          onError?.(err instanceof Error ? err : new Error(String(err)))
        }
      }
    },

    reset(): void {
      clearBuffer()
      discardingOversizedLine = false
    }
  }
}
