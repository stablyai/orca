import type { MessageType } from './types'

export function bindCoordinatorMutationPayload(
  type: MessageType,
  payload: string | null | undefined,
  dispatchId: string
): string | undefined {
  if (type !== 'escalation' && type !== 'decision_gate') {
    return payload ?? undefined
  }
  if (!payload) {
    return JSON.stringify({ dispatchId })
  }
  try {
    const parsed: unknown = JSON.parse(payload)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return payload
    }
    return JSON.stringify({ ...parsed, dispatchId })
  } catch {
    return payload
  }
}
