// Why: SSE parsing for the opencode2 service /api/event stream, kept separate
// from the hook-service lifecycle so neither file needs a max-lines disable.

export type OpenCode2SseEnvelope = {
  event: string
  data: string
}

/**
 * Read an SSE body line by line and emit each complete `data:` payload.
 * The stream is volatile by contract; `onClose` always runs once the read
 * loop settles so the caller can reconnect while its terminals remain.
 */
export async function consumeOpenCode2EventStream(
  body: ReadableStream<Uint8Array>,
  onEnvelope: (payload: string) => void,
  onClose: () => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let lineEnd = buffer.indexOf('\n')
      while (lineEnd !== -1) {
        const line = buffer.slice(0, lineEnd).replace(/\r$/, '')
        buffer = buffer.slice(lineEnd + 1)
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart())
        } else if (line.length === 0 && dataLines.length > 0) {
          const payload = dataLines.join('\n')
          dataLines = []
          onEnvelope(payload)
        }
        lineEnd = buffer.indexOf('\n')
      }
    }
  } catch {
    // stream died; onClose handles the reconnect
  } finally {
    reader.releaseLock()
    onClose()
  }
}

export function parseOpenCode2SseEnvelope(payload: string): OpenCode2SseEnvelope | null {
  try {
    const envelope = JSON.parse(payload) as OpenCode2SseEnvelope
    if (typeof envelope.event !== 'string' || typeof envelope.data !== 'string') {
      return null
    }
    return envelope
  } catch {
    return null
  }
}

export function parseOpenCode2EventRecord(data: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

export function readOpenCode2RecordString(
  record: Record<string, unknown>,
  key: string
): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}
