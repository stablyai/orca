import AsyncStorage from '@react-native-async-storage/async-storage'

const WATERMARK_STORAGE_KEY_PREFIX = 'orca:mobileNotificationsWatermark:'
// Pre-#8591 installs wrote the seq alone. Read once to migrate; never written.
const LEGACY_SEQ_STORAGE_KEY_PREFIX = 'orca:mobileNotificationsLastSeq:'

type WatermarkPersistenceState = {
  generation: number
  tail: Promise<void>
}

// AsyncStorage writes cannot be cancelled, so each host's clear is ordered after prior
// IO while its generation fence drops writers that had not entered storage yet.
const persistenceByHost = new Map<string, WatermarkPersistenceState>()

function getPersistenceState(hostId: string): WatermarkPersistenceState {
  let state = persistenceByHost.get(hostId)
  if (!state) {
    state = { generation: 0, tail: Promise.resolve() }
    persistenceByHost.set(hostId, state)
  }
  return state
}

function watermarkStorageKey(hostId: string): string {
  return WATERMARK_STORAGE_KEY_PREFIX + encodeURIComponent(hostId)
}

export type PersistedWatermark = { seq: number; epoch: string | null }
export type LoadedWatermark = PersistedWatermark & { stored: boolean }

function coerceSeq(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export async function loadWatermark(hostId: string): Promise<LoadedWatermark> {
  try {
    const raw = await AsyncStorage.getItem(watermarkStorageKey(hostId))
    if (raw != null) {
      const parsed = JSON.parse(raw) as { seq?: unknown; epoch?: unknown }
      const epoch =
        typeof parsed.epoch === 'string' && parsed.epoch.length > 0 ? parsed.epoch : null
      return { seq: coerceSeq(parsed.seq), epoch, stored: true }
    }
  } catch {
    // Unreadable or malformed: fall through to the legacy key rather than throw.
  }
  try {
    const legacy = await AsyncStorage.getItem(
      LEGACY_SEQ_STORAGE_KEY_PREFIX + encodeURIComponent(hostId)
    )
    return { seq: coerceSeq(legacy), epoch: null, stored: legacy != null }
  } catch {
    return { seq: 0, epoch: null, stored: false }
  }
}

export async function clearWatermark(hostId: string): Promise<void> {
  const state = getPersistenceState(hostId)
  state.generation += 1
  // Remove both: loadWatermark falls back to the legacy key.
  const clearing = state.tail.then(async () => {
    await Promise.all([
      AsyncStorage.removeItem(watermarkStorageKey(hostId)).catch(() => {}),
      AsyncStorage.removeItem(LEGACY_SEQ_STORAGE_KEY_PREFIX + encodeURIComponent(hostId)).catch(
        () => {}
      )
    ])
  })
  state.tail = clearing.catch(() => {})
  await clearing
}

export async function saveWatermark(hostId: string, watermark: PersistedWatermark): Promise<void> {
  const state = getPersistenceState(hostId)
  const generation = state.generation
  const saving = state.tail.then(async () => {
    if (generation !== state.generation) {
      return
    }
    try {
      await AsyncStorage.setItem(watermarkStorageKey(hostId), JSON.stringify(watermark))
    } catch {
      // A lagging watermark can duplicate after restart, but cannot cut an unseen event.
    }
  })
  state.tail = saving.catch(() => {})
  await saving
}

export function resetWatermarkPersistenceForTests(): void {
  persistenceByHost.clear()
}
