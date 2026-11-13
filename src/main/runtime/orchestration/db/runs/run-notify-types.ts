import {
  MESSAGE_TYPES,
  type MessageType
} from '../../../../../shared/orchestration/orchestration-message-types'

/** NULL wakes for every type; [] silences wake pointers. Unknown entries are dropped; all-unknown fails open. */
export function parseRunNotifyTypes(raw: string | null | undefined): MessageType[] | null {
  if (raw === null || raw === undefined) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return null
    }
    if (parsed.length === 0) {
      return []
    }
    const known = parsed.filter((type): type is MessageType => MESSAGE_TYPES.includes(type))
    return known.length > 0 ? known : null
  } catch {
    return null
  }
}

export function serializeRunNotifyTypes(
  types: readonly MessageType[] | null | undefined
): string | null {
  return types === undefined || types === null ? null : JSON.stringify(types)
}
