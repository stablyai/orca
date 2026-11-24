import { leadingJsonEnvelope } from '../../shared/json-stream/json-rpc-record-prefix'

const ENVELOPE_SCAN_CHARS = 4096
const ENVELOPE_MAX_FIELDS = 32

/** True for an answer to a request this app sent (ids above the last app's), read from its envelope. */
export function isJsonRpcAnswerAbove(line: string, floor: number): boolean {
  if (!line.includes('"id"') || (!line.includes('"result"') && !line.includes('"error"'))) {
    return false
  }
  const { properties, complete } = leadingJsonEnvelope(line.slice(0, ENVELOPE_SCAN_CHARS), {
    stopAtContainer: true,
    maxFields: ENVELOPE_MAX_FIELDS
  })
  const keys = new Set(properties.map((property) => property.key))
  if (complete && keys.size === properties.length) {
    const id = properties.find((property) => property.key === 'id')?.value
    return (
      !keys.has('method') &&
      (keys.has('result') || keys.has('error')) &&
      typeof id === 'number' &&
      id > floor
    )
  }
  // Cut off or with a repeated key: only a full parse reads it as the connection will.
  try {
    const message: unknown = JSON.parse(line)
    if (typeof message !== 'object' || message === null || 'method' in message) {
      return false
    }
    const { id } = message as { id?: unknown }
    return typeof id === 'number' && id > floor
  } catch {
    return false
  }
}

/** The `result` of a kept JSON-RPC answer line; undefined when there is none or it can't be read. */
export function jsonRpcResultOf(line: string | null | undefined): unknown {
  if (!line) {
    return undefined
  }
  try {
    const message = JSON.parse(line) as { result?: unknown }
    return typeof message === 'object' && message !== null ? message.result : undefined
  } catch {
    return undefined
  }
}
