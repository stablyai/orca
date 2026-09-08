import AsyncStorage from '@react-native-async-storage/async-storage'
import { sha256 } from '../../../src/shared/sha256'
import {
  MOBILE_WEB_PAGE_PREFERENCES_MAX_BYTES,
  MOBILE_WEB_PAGE_PREFERENCE_MAX_VALUE_BYTES,
  MobileWebPagePreferencesPayloadSchema,
  MobileWebPagePreferencesStoredSchema,
  type MobileWebPagePreferencesPayload,
  type MobileWebPagePreferencesResult
} from '../../../src/shared/mobile-web/page-preferences-contract'
import { MobileWebBrokerError } from './mobile-web-broker-error'

type Storage = Pick<typeof AsyncStorage, 'getItem' | 'setItem'>
type Queue = { tail: Promise<unknown>; count: number }
const queues = new Map<string, Queue>()

export function mobileWebPagePreferencesStorageKey(hostIdentity: string): string {
  const hash = Array.from(sha256(new TextEncoder().encode(hostIdentity)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  return `orca:hosted-page-preferences:v1:${hash}`
}

// Unpairing owns no page session, so the blob can go without the request queue.
export async function deleteMobileWebPagePreferences(hostIdentity: string): Promise<void> {
  await AsyncStorage.removeItem(mobileWebPagePreferencesStorageKey(hostIdentity))
}

export function runMobileWebPagePreferences(
  hostIdentity: string,
  input: MobileWebPagePreferencesPayload,
  storage: Storage = AsyncStorage
): Promise<MobileWebPagePreferencesResult> {
  const payload = MobileWebPagePreferencesPayloadSchema.parse(input)
  if (!hostIdentity) {
    return Promise.reject(new MobileWebBrokerError('unavailable'))
  }
  const key = mobileWebPagePreferencesStorageKey(hostIdentity)
  const queue = queues.get(key) ?? { tail: Promise.resolve(), count: 0 }
  if (queue.count >= 32) {
    return Promise.reject(new MobileWebBrokerError('rate_limited'))
  }
  queue.count += 1
  queues.set(key, queue)
  const result = queue.tail.catch(() => {}).then(() => applyPreferences(key, payload, storage))
  queue.tail = result.catch(() => {})
  return result.finally(() => {
    queue.count -= 1
    if (queue.count === 0 && queues.get(key) === queue) {
      queues.delete(key)
    }
  })
}

async function applyPreferences(
  key: string,
  payload: MobileWebPagePreferencesPayload,
  storage: Storage
): Promise<MobileWebPagePreferencesResult> {
  const raw = await storage.getItem(key)
  const oversized = raw !== null && byteLength(raw) > MOBILE_WEB_PAGE_PREFERENCES_MAX_BYTES
  const namespaces = oversized ? null : readNamespaces(raw)
  if (!namespaces) {
    // A reset and a read must survive a blob this device can no longer use.
    if (payload.action === 'clear') {
      await storage.setItem(key, '[]')
      return { updated: true }
    }
    if (payload.action === 'read') {
      warnUnreadablePreferences()
      return { entries: payload.keys.map((entryKey) => [entryKey, null]) }
    }
    throw new MobileWebBrokerError(oversized ? 'too_large' : 'unavailable')
  }
  const values = namespaces.get(payload.namespace) ?? new Map<string, string>()
  if (payload.action === 'read') {
    return { entries: payload.keys.map((key) => [key, values.get(key) ?? null]) }
  }
  if (payload.action === 'keys') {
    return { keys: [...values.keys()] }
  }
  if (payload.action === 'write') {
    for (const [entryKey, value] of payload.entries) {
      if (byteLength(value) > MOBILE_WEB_PAGE_PREFERENCE_MAX_VALUE_BYTES) {
        throw new MobileWebBrokerError('too_large')
      }
      values.set(entryKey, value)
    }
  } else if (payload.action === 'remove') {
    for (const entryKey of payload.keys) {
      values.delete(entryKey)
    }
  } else {
    values.clear()
  }
  if (values.size) {
    namespaces.set(payload.namespace, values)
  } else {
    namespaces.delete(payload.namespace)
  }
  const next = [...namespaces].map(([namespace, entries]) => [namespace, [...entries]])
  if (namespaces.size > 16 || values.size > 256) {
    throw new MobileWebBrokerError('too_large')
  }
  const serialized = JSON.stringify(next)
  if (byteLength(serialized) > MOBILE_WEB_PAGE_PREFERENCES_MAX_BYTES) {
    throw new MobileWebBrokerError('too_large')
  }
  await storage.setItem(key, serialized)
  return { updated: true }
}

function readNamespaces(raw: string | null): Map<string, Map<string, string>> | null {
  let stored
  try {
    stored = MobileWebPagePreferencesStoredSchema.parse(raw ? JSON.parse(raw) : [])
  } catch {
    return null
  }
  const namespaces = new Map(stored.map(([namespace, entries]) => [namespace, new Map(entries)]))
  const duplicated =
    namespaces.size !== stored.length ||
    stored.some(([, entries]) => new Map(entries).size !== entries.length)
  return duplicated ? null : namespaces
}

let warnedUnreadablePreferences = false
function warnUnreadablePreferences(): void {
  if (!warnedUnreadablePreferences) {
    warnedUnreadablePreferences = true
    console.warn('[mobile-web] page preferences unreadable — serving empty values')
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
