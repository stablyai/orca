import AsyncStorage from '@react-native-async-storage/async-storage'
import { createConnectionLogStore } from './connection-log-buffer'
import { RELAY_DIAL_STAGE_NAMES } from './relay-dial-stage'
import { CONNECTION_STATE_NAMES, type ConnectionLogEntry, type ConnectionLogTiming } from './types'

const STORAGE_PREFIX = 'orca.mobile.connection-log.v1.'
const clientSessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
const sessionStartedHosts = new Set<string>()

export const connectionLogStore = createConnectionLogStore(200, {
  async load(hostId) {
    const raw = await AsyncStorage.getItem(storageKey(hostId))
    if (!raw) {
      return []
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter(isConnectionLogEntry) : []
    } catch {
      return []
    }
  },
  save(hostId, entries) {
    return AsyncStorage.setItem(storageKey(hostId), JSON.stringify(entries))
  }
})

export function recordConnectionRevival(
  hostId: string,
  reason: 'app-resume' | 'network-change'
): void {
  const now = Date.now()
  connectionLogStore.append(hostId, {
    id: `revival-${reason}-${now}`,
    ts: now,
    level: 'info',
    code: reason === 'app-resume' ? 'app-resumed' : 'network-changed',
    message: reason === 'app-resume' ? 'App returned to foreground' : 'Network changed',
    detail: 'Connection recovery notified'
  })
}

export function recordConnectionClientSessionStart(hostId: string): void {
  if (sessionStartedHosts.has(hostId)) {
    return
  }
  sessionStartedHosts.add(hostId)
  const now = Date.now()
  connectionLogStore.append(hostId, {
    id: `client-session-${clientSessionId}-${now}`,
    ts: now,
    level: 'info',
    code: 'client-session-started',
    message: 'Mobile client session started'
  })
}

function storageKey(hostId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(hostId)}`
}

function isConnectionLogEntry(value: unknown): value is ConnectionLogEntry {
  if (!value || typeof value !== 'object') {
    return false
  }
  const entry = value as Partial<ConnectionLogEntry>
  return (
    typeof entry.id === 'string' &&
    typeof entry.ts === 'number' &&
    Number.isFinite(entry.ts) &&
    (entry.level === 'info' ||
      entry.level === 'success' ||
      entry.level === 'warn' ||
      entry.level === 'error') &&
    typeof entry.message === 'string' &&
    (entry.detail === undefined || typeof entry.detail === 'string') &&
    (entry.timing === undefined || isConnectionLogTiming(entry.timing))
  )
}

// Why: the report echoes the phase name and formats the duration directly, so a
// corrupted stored timing must not reach it. The name is checked against the closed
// enum for its kind, not just "is a string", and the duration must be one a producer
// could have written — `elapsedMs` clamps at 0, so a negative is corruption.
function isConnectionLogTiming(value: unknown): value is ConnectionLogTiming {
  if (!value || typeof value !== 'object') {
    return false
  }
  const timing = value as Partial<ConnectionLogTiming>
  if (timing.kind !== 'relay-dial-stage' && timing.kind !== 'connection-state') {
    return false
  }
  const names = timing.kind === 'relay-dial-stage' ? RELAY_DIAL_STAGE_NAMES : CONNECTION_STATE_NAMES
  return (
    typeof timing.name === 'string' &&
    Object.hasOwn(names, timing.name) &&
    typeof timing.ms === 'number' &&
    Number.isFinite(timing.ms) &&
    timing.ms >= 0 &&
    typeof timing.complete === 'boolean'
  )
}
