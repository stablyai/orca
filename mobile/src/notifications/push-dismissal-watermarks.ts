import AsyncStorage from '@react-native-async-storage/async-storage'
import type { OrcaPushPayload } from './push-payload'
import { nativePushDismissal } from './native-push-dismissal'

const STORAGE_KEY = 'orca:pushDismissalWatermarks:v1'
// Keep every live fence: count-based eviction lets delayed alerts reappear.
const RETENTION_MS = 24 * 60 * 60 * 1000

type Entry = { key: string; seq: number; expiresAt: number }
let writes: Promise<void> = Promise.resolve()

function queueDismissalOperation<T>(operation: () => Promise<T>): Promise<T> {
  const pending = writes.then(operation)
  writes = pending.then(
    () => {},
    () => {}
  )
  return pending
}

function eventKey(payload: OrcaPushPayload): string | null {
  if (
    !payload.notificationId ||
    !payload.notificationEpoch ||
    !Number.isSafeInteger(payload.notificationSeq) ||
    payload.notificationSeq! < 0
  ) {
    return null
  }
  return JSON.stringify([
    payload.hostFingerprint,
    payload.notificationEpoch,
    payload.notificationId
  ])
}

async function readEntries(): Promise<Entry[]> {
  try {
    const raw: unknown = JSON.parse((await AsyncStorage.getItem(STORAGE_KEY)) ?? '[]')
    if (!Array.isArray(raw)) {
      return []
    }
    return raw.filter(
      (entry): entry is Entry =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof entry.key === 'string' &&
        Number.isSafeInteger(entry.seq) &&
        entry.seq >= 0 &&
        Number.isFinite(entry.expiresAt) &&
        entry.expiresAt > Date.now()
    )
  } catch {
    return []
  }
}

export async function rememberPushDismissal(payload: OrcaPushPayload): Promise<void> {
  return rememberPushDismissals([payload])
}

export async function rememberPushDismissals(payloads: readonly OrcaPushPayload[]): Promise<void> {
  const valid = payloads.flatMap((payload) => {
    const key = eventKey(payload)
    return key === null ? [] : [{ key, payload }]
  })
  if (valid.length === 0) {
    return
  }
  return queueDismissalOperation(async () => {
    if (nativePushDismissal) {
      for (const { payload } of valid) {
        await nativePushDismissal.remember(payload)
      }
      return
    }
    const entries = new Map((await readEntries()).map((entry) => [entry.key, entry]))
    const expiresAt = Date.now() + RETENTION_MS
    for (const { key, payload } of valid) {
      const seq = Math.max(entries.get(key)?.seq ?? 0, payload.notificationSeq!)
      entries.delete(key)
      entries.set(key, { key, seq, expiresAt })
    }
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...entries.values()]))
  })
}

async function readDismissal(payload: OrcaPushPayload, key: string): Promise<boolean> {
  if (nativePushDismissal) {
    return nativePushDismissal.wasDismissed(payload)
  }
  return (await readEntries()).some(
    (entry) => entry.key === key && entry.seq >= payload.notificationSeq!
  )
}

export async function wasPushDismissed(payload: OrcaPushPayload): Promise<boolean> {
  const key = eventKey(payload)
  if (!key) {
    return false
  }
  const precedingWrites = writes
  await precedingWrites
  const dismissed = await readDismissal(payload, key)
  if (dismissed || writes === precedingWrites) {
    return dismissed
  }
  // An overtaking write invalidates a negative snapshot; one queued read cannot be overtaken again.
  return queueDismissalOperation(() => readDismissal(payload, key))
}
