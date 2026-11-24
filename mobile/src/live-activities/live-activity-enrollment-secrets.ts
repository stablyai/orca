import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import * as z from 'zod'

const KEY = 'orca:liveActivitySecretCleanup:v2'
const keysSchema = z.array(
  z.string().regex(/^orca\.activity\.[a-f0-9-]{36}\.(control|[a-f0-9]{64})$/)
)

export const liveActivitySecretKey = (overviewId: string, scopeId: string): string =>
  `orca.activity.${overviewId}.${scopeId}`

async function readKeys(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(KEY)
  return keysSchema.parse(raw ? JSON.parse(raw) : [])
}

// Enrollment's serialized writer owns this ledger and the active-cohort record together.
export async function rememberLiveActivitySecrets(
  overviewId: string,
  scopeIds: string[]
): Promise<void> {
  const keys = new Set(await readKeys())
  for (const scopeId of [...scopeIds, 'control']) {
    keys.add(liveActivitySecretKey(overviewId, scopeId))
  }
  await AsyncStorage.setItem(KEY, JSON.stringify([...keys]))
}

export async function cleanLiveActivitySecrets(activeOverviewId?: string): Promise<void> {
  const keys = await readKeys()
  const pending = keys.filter(
    (key) => !activeOverviewId || !key.startsWith(`orca.activity.${activeOverviewId}.`)
  )
  const results = await Promise.allSettled(pending.map((key) => SecureStore.deleteItemAsync(key)))
  const failed = pending.filter((_, index) => results[index].status === 'rejected')
  if (failed.length) {
    await AsyncStorage.setItem(KEY, JSON.stringify(failed))
    throw new Error('Live Activity secret cleanup pending')
  }
  await AsyncStorage.removeItem(KEY)
}
