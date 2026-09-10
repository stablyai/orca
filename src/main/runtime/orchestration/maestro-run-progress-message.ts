import type { DispatchContextRow, MessageRow } from './types'

export function latestAcceptedDispatchMessage(
  dispatch: DispatchContextRow | undefined,
  messages: readonly MessageRow[],
  types: readonly MessageRow['type'][]
): MessageRow | undefined {
  if (!dispatch) {
    return undefined
  }
  return messages
    .filter((message) => {
      if (!types.includes(message.type) || message.run_id !== dispatch.run_id) {
        return false
      }
      const payload = parseProgressPayload(message.payload)
      return payload?.dispatchId === dispatch.id && !payload._orcaLifecycleRejection
    })
    .sort((left, right) => right.sequence - left.sequence)[0]
}

export function parseProgressPayload(payload: string | null): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(payload ?? '')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}
