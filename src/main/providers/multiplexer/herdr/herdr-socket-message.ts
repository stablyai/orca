import type {
  HerdrSocketEvent,
  HerdrSocketMessage,
  HerdrSocketRequest,
  HerdrSocketResponse
} from './herdr-socket-types'

export function encodeSocketMessage(message: HerdrSocketRequest): string {
  return `${JSON.stringify(message)}\n`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isSocketResponse(message: unknown): message is HerdrSocketResponse {
  if (!isPlainObject(message)) {
    return false
  }
  return typeof message.id === 'string' && ('result' in message || 'error' in message)
}

export function isSocketEvent(message: unknown): message is HerdrSocketEvent {
  if (!isPlainObject(message)) {
    return false
  }
  return typeof message.event === 'string' && isPlainObject(message.data)
}

export function decodeSocketMessage(line: string): HerdrSocketResponse | HerdrSocketEvent | null {
  const trimmed = line.trim()
  if (!trimmed) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (isSocketEvent(parsed) || isSocketResponse(parsed)) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

export function createRequest(method: string, params: unknown, id?: string): HerdrSocketRequest {
  return {
    id: id ?? crypto.randomUUID(),
    method,
    params
  }
}

export function createRequestId(): string {
  return crypto.randomUUID()
}

export class HerdrSocketMessageParser {
  private buffer = ''

  feed(chunk: string): HerdrSocketMessage[] {
    this.buffer += chunk
    const messages: HerdrSocketMessage[] = []

    let newlineIndex: number
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)

      const decoded = decodeSocketMessage(line)
      if (decoded) {
        messages.push(decoded)
      }
    }

    return messages
  }

  flush(): HerdrSocketMessage[] {
    const messages: HerdrSocketMessage[] = []
    if (this.buffer.trim()) {
      const decoded = decodeSocketMessage(this.buffer)
      if (decoded) {
        messages.push(decoded)
      }
      this.buffer = ''
    }
    return messages
  }

  reset(): void {
    this.buffer = ''
  }
}
