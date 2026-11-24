/** True for an answer to a request this app sent (ids above the last app's), cheaply tested first. */
export function isJsonRpcAnswerAbove(line: string, floor: number): boolean {
  if (!line.includes('"id"') || (!line.includes('"result"') && !line.includes('"error"'))) {
    return false
  }
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
