export function encodeNdjson(msg: unknown): string {
  return `${JSON.stringify(msg)}\n`
}

export const NDJSON_MAX_LINE_BYTES = 16 * 1024 * 1024

export type NdjsonParser = {
  feed(chunk: string): void
  reset(): void
}

export type NdjsonParserOptions = {
  maxLineBytes?: number
}

export function createNdjsonParser(
  onMessage: (msg: unknown) => void,
  onError?: (err: Error) => void,
  options: NdjsonParserOptions = {}
): NdjsonParser {
  let buffer = ''
  let bufferBytes = 0
  let discardingOversizedLine = false
  const maxLineBytes = Math.max(1, options.maxLineBytes ?? NDJSON_MAX_LINE_BYTES)

  const clearBuffer = (): void => {
    buffer = ''
    bufferBytes = 0
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

        const segmentBytes = Buffer.byteLength(segment, 'utf8')
        const nextLineBytes = bufferBytes + segmentBytes
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

        buffer += segment
        bufferBytes = nextLineBytes
        if (!hasNewline) {
          return
        }

        const line = buffer
        clearBuffer()

        if (line.length === 0) {
          continue
        }

        try {
          onMessage(JSON.parse(line))
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
