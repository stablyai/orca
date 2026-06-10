import type { ClaudeStreamEvent } from './claude-chat-events'

// Parses a stream of stdout chunks (which may split lines arbitrarily) into
// complete ClaudeStreamEvent objects. Each JSON object is on its own line (NDJSON).
export class NdjsonParser {
  private buf = ''

  // Append a chunk, split on newlines, parse complete lines, return parsed events.
  // Incomplete trailing segment stays in the buffer for the next push.
  push(chunk: string): ClaudeStreamEvent[] {
    this.buf += chunk
    const lines = this.buf.split('\n')
    // Last element is the incomplete trailing segment (or '' if chunk ended with \n)
    this.buf = lines.pop() ?? ''
    const events: ClaudeStreamEvent[] = []
    for (const line of lines) {
      const evt = tryParse(line)
      if (evt !== null) {
        events.push(evt)
      }
    }
    return events
  }

  // Attempt to parse whatever remains in the buffer (e.g. at stream end).
  // Returns the parsed event in an array, or [] if buffer is empty/invalid.
  flush(): ClaudeStreamEvent[] {
    const remaining = this.buf
    this.buf = ''
    const evt = tryParse(remaining)
    return evt !== null ? [evt] : []
  }
}

// Returns parsed object or null for blank/whitespace lines and invalid JSON.
function tryParse(line: string): ClaudeStreamEvent | null {
  if (line.trim() === '') {
    return null
  }
  try {
    return JSON.parse(line) as ClaudeStreamEvent
  } catch {
    return null
  }
}
