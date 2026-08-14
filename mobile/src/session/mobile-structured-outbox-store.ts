import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  parseStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../src/shared/structured-agent-session-outbox'

export type MobileStructuredOutboxEntry = StructuredAgentSessionOutboxEntry
export type MobileStructuredOutboxState = StructuredAgentSessionOutboxEntry['state']

const STORAGE_PREFIX = 'orca:structuredAgentSessionOutbox:v1:'
export const MAX_MOBILE_STRUCTURED_OUTBOX_ENTRIES = 64

function storageKey(sessionId: string): string {
  return STORAGE_PREFIX + encodeURIComponent(sessionId)
}

export async function loadMobileStructuredOutbox(
  sessionId: string
): Promise<MobileStructuredOutboxEntry[]> {
  try {
    const parsed = JSON.parse((await AsyncStorage.getItem(storageKey(sessionId))) ?? '[]')
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed
      .slice(-MAX_MOBILE_STRUCTURED_OUTBOX_ENTRIES)
      .map((entry) => parseStructuredAgentSessionOutboxEntry(entry, sessionId))
      .filter((entry): entry is MobileStructuredOutboxEntry => entry !== null)
      .map((entry) =>
        entry.state === 'dispatching' ? { ...entry, state: 'unconfirmed' as const } : entry
      )
      .sort((left, right) => left.queuedAt - right.queuedAt)
  } catch {
    return []
  }
}

export async function saveMobileStructuredOutbox(
  sessionId: string,
  entries: readonly MobileStructuredOutboxEntry[]
): Promise<void> {
  const bounded = entries.filter((entry) => entry.sessionId === sessionId)
  if (bounded.length > MAX_MOBILE_STRUCTURED_OUTBOX_ENTRIES) {
    throw new Error(`Structured outbox is full (${MAX_MOBILE_STRUCTURED_OUTBOX_ENTRIES} messages)`)
  }
  if (bounded.length === 0) {
    await AsyncStorage.removeItem(storageKey(sessionId))
    return
  }
  await AsyncStorage.setItem(storageKey(sessionId), JSON.stringify(bounded))
}
