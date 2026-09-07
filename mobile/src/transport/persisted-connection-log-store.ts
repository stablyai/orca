import AsyncStorage from '@react-native-async-storage/async-storage'
import { createConnectionLogStore } from './connection-log-buffer'
import type { ConnectionLogEntry, ConnectionLogTiming } from './types'

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

// Why: the report formats these durations directly, so a corrupted stored timing
// must not reach it.
function isConnectionLogTiming(value: unknown): value is ConnectionLogTiming {
  if (!value || typeof value !== 'object') {
    return false
  }
  const timing = value as Partial<ConnectionLogTiming>
  return (
    (timing.kind === 'relay-dial-stage' || timing.kind === 'connection-state') &&
    typeof timing.name === 'string' &&
    typeof timing.ms === 'number' &&
    Number.isFinite(timing.ms) &&
    typeof timing.complete === 'boolean'
  )
}
