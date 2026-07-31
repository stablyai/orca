import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  MobileRelayHostOverlaySchema,
  type MobileRelayHostOverlay
} from './mobile-relay-host-overlay'
import { SecureStoreLatestValueCoordinator } from './secure-store-latest-value-coordinator'
import { parseMobileJsonTextWithinLimits } from './mobile-json-text-admission'

const OVERLAY_STORAGE_KEY = 'orca:mobile-relay:host-overlays:v2'
const OVERLAY_KEY_PREFIX = 'orca:mobile-relay:host-overlay:v3:'
export const MOBILE_RELAY_HOST_OVERLAY_MAX_ENTRIES = 64
export const MOBILE_RELAY_HOST_OVERLAY_MAX_STORAGE_CHARACTERS = 512 * 1024
let overlayMutation: Promise<void> = Promise.resolve()

function overlayKey(hostId: string): string {
  return `${OVERLAY_KEY_PREFIX}${hostId}`
}

const overlayWrites = new SecureStoreLatestValueCoordinator(async (hostId, desired) => {
  if (desired) {
    await AsyncStorage.setItem(overlayKey(hostId), desired.value)
  } else {
    await AsyncStorage.removeItem(overlayKey(hostId))
  }
})

function parseOverlays(raw: string | null): MobileRelayHostOverlay[] | null {
  if (raw === null) {
    return []
  }
  if (raw.length > MOBILE_RELAY_HOST_OVERLAY_MAX_STORAGE_CHARACTERS) {
    return null
  }
  try {
    const value = parseMobileJsonTextWithinLimits(raw)
    if (!Array.isArray(value) || value.length > MOBILE_RELAY_HOST_OVERLAY_MAX_ENTRIES) {
      return null
    }
    return value.flatMap((item) => {
      const result = MobileRelayHostOverlaySchema.safeParse(item)
      return result.success ? [result.data] : []
    })
  } catch {
    return null
  }
}

function parseOverlay(raw: string | null): MobileRelayHostOverlay | null {
  if (!raw || raw.length > MOBILE_RELAY_HOST_OVERLAY_MAX_STORAGE_CHARACTERS) {
    return null
  }
  try {
    const result = MobileRelayHostOverlaySchema.safeParse(parseMobileJsonTextWithinLimits(raw))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

async function readKnownHostOverlay(
  hostId: string
): Promise<{ hostId: string; raw: string | null; readable: boolean }> {
  const pending = overlayWrites.pending(hostId)
  if (pending.present) {
    return { hostId, raw: pending.value, readable: true }
  }
  try {
    return { hostId, raw: await AsyncStorage.getItem(overlayKey(hostId)), readable: true }
  } catch {
    return { hostId, raw: null, readable: false }
  }
}

async function readOverlaysForMutation(): Promise<MobileRelayHostOverlay[]> {
  const overlays = parseOverlays(await AsyncStorage.getItem(OVERLAY_STORAGE_KEY))
  if (!overlays) {
    // Why: never rewrite an unreadable v2 namespace as an empty list; doing so
    // would destroy relay recovery data during an unrelated host mutation.
    throw new Error('mobile relay host overlay storage unreadable')
  }
  return overlays
}

async function mutateOverlays(
  update: (overlays: MobileRelayHostOverlay[]) => MobileRelayHostOverlay[]
): Promise<void> {
  const mutation = overlayMutation.then(async () => {
    const current = await readOverlaysForMutation()
    const next = update(current)
    // Why: direct-only saves commonly have no overlay to remove; avoid a full
    // AsyncStorage write when cleanup leaves the durable list unchanged.
    if (next !== current) {
      const serialized = JSON.stringify(next)
      if (serialized.length > MOBILE_RELAY_HOST_OVERLAY_MAX_STORAGE_CHARACTERS) {
        throw new Error('mobile relay host overlay storage limit exceeded')
      }
      await AsyncStorage.setItem(OVERLAY_STORAGE_KEY, serialized)
    }
  })
  overlayMutation = mutation.catch(() => {})
  return mutation
}

export async function loadMobileRelayHostOverlays(
  existingHostIds: ReadonlySet<string>
): Promise<Map<string, MobileRelayHostOverlay>> {
  return (await loadMobileRelayHostOverlayState(existingHostIds)).overlays
}

export async function loadMobileRelayHostOverlayState(
  existingHostIds: ReadonlySet<string>
): Promise<{ overlays: Map<string, MobileRelayHostOverlay>; orphanHostIds: string[] }> {
  const overlays = parseOverlays(await AsyncStorage.getItem(OVERLAY_STORAGE_KEY)) ?? []
  const active = new Map<string, MobileRelayHostOverlay>()
  const orphanHostIds = new Set<string>()
  for (const overlay of overlays) {
    // Why: an older app can remove the legacy base without knowing this
    // namespace; never let the retained overlay resurrect that host later.
    if (existingHostIds.has(overlay.hostId)) {
      active.set(overlay.hostId, overlay)
    } else {
      orphanHostIds.add(overlay.hostId)
    }
  }
  const knownReads = await Promise.all([...existingHostIds].map(readKnownHostOverlay))
  for (const { hostId, raw, readable } of knownReads) {
    if (!readable) {
      active.delete(hostId)
      continue
    }
    const overlay = parseOverlay(raw)
    if (overlay?.hostId === hostId) {
      active.set(hostId, overlay)
    } else if (raw !== null) {
      active.delete(hostId)
    }
  }
  const keys =
    typeof AsyncStorage.getAllKeys === 'function'
      ? await AsyncStorage.getAllKeys().catch((): string[] => [])
      : []
  for (const key of keys) {
    if (!key.startsWith(OVERLAY_KEY_PREFIX)) {
      continue
    }
    const hostId = key.slice(OVERLAY_KEY_PREFIX.length)
    if (existingHostIds.has(hostId)) {
      continue
    }
    const pending = overlayWrites.pending(hostId)
    const raw = pending.present ? pending.value : await AsyncStorage.getItem(key)
    const overlay = parseOverlay(raw)
    if (overlay?.hostId === hostId) {
      orphanHostIds.add(hostId)
    }
  }
  return { overlays: active, orphanHostIds: [...orphanHostIds] }
}

export async function saveMobileRelayHostOverlay(overlay: MobileRelayHostOverlay): Promise<void> {
  const validated = MobileRelayHostOverlaySchema.parse(overlay)
  const serialized = JSON.stringify(validated)
  if (serialized.length > MOBILE_RELAY_HOST_OVERLAY_MAX_STORAGE_CHARACTERS) {
    throw new Error('mobile relay host overlay storage limit exceeded')
  }
  await overlayWrites.replace(validated.hostId, serialized)
}

export function removeMobileRelayHostOverlay(hostId: string): Promise<void> {
  return removeMobileRelayHostOverlays([hostId])
}

export function removeMobileRelayHostOverlays(hostIds: readonly string[]): Promise<void> {
  const targets = new Set(hostIds)
  const removal = Promise.all([...targets].map((hostId) => overlayWrites.delete(hostId))).then(
    () => undefined
  )
  void mutateOverlays((overlays) => {
    const next = overlays.filter((overlay) => !targets.has(overlay.hostId))
    return next.length === overlays.length ? overlays : next
  }).catch(() => {})
  return removal
}

/** Test-only: drain the module mutation chain between cases. */
export function resetMobileRelayHostOverlayStoreForTests(): void {
  overlayMutation = Promise.resolve()
  overlayWrites.resetForTests()
}
