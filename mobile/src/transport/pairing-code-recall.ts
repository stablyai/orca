import AsyncStorage from '@react-native-async-storage/async-storage'
import { z } from 'zod'

const STORAGE_KEY = 'orca:last-pairing-code'
// Why: the code carries the pairing credential, so a stale copy must not linger.
const RECALL_TTL_MS = 15 * 60 * 1000

const StoredRecallSchema = z.object({
  code: z.string().min(1),
  savedAt: z.number().int().positive()
})

// Why: a failed pairing should not force the user to re-scan the QR code;
// the last attempted code is offered again until one succeeds or it expires.
export function rememberPairingCode(raw: string): Promise<void> {
  return AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ code: raw.trim(), savedAt: Date.now() })
  )
}

export function clearRecalledPairingCode(): Promise<void> {
  return AsyncStorage.removeItem(STORAGE_KEY)
}

export async function loadRecalledPairingCode(): Promise<string | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY)
  if (raw === null) {
    return null
  }
  try {
    const parsed = StoredRecallSchema.parse(JSON.parse(raw))
    if (Date.now() - parsed.savedAt > RECALL_TTL_MS) {
      await clearRecalledPairingCode()
      return null
    }
    return parsed.code
  } catch {
    await clearRecalledPairingCode().catch(() => {})
    return null
  }
}
