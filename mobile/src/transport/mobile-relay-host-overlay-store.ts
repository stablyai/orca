import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  MobileRelayHostOverlaySchema,
  type MobileRelayHostOverlay
} from './mobile-relay-host-overlay'
import { parseMobileJsonTextWithinLimits } from './mobile-json-text-admission'

const OVERLAY_STORAGE_KEY = 'orca:mobile-relay:host-overlays:v2'
export const MOBILE_RELAY_HOST_OVERLAY_MAX_ENTRIES = 64
export const MOBILE_RELAY_HOST_OVERLAY_MAX_STORAGE_CHARACTERS = 512 * 1024
let overlayMutation: Promise<void> = Promise.resolve()

function parseOverlays(raw: string | null): MobileRelayHostOverlay[] | null {
  if (raw === null) {
    return []
  }
  if (raw.length > MOBILE_RELAY_HOST_OVERLAY_MAX_STORAGE_CHARACTERS) {
    return null
  }
  try {
    const value = parseMobileJsonTextWithinLimits(raw)
    if (!Array.isArray(value)) {
      return null
    }
    if (value.length > MOBILE_RELAY_HOST_OVERLAY_MAX_ENTRIES) {
      return null
    }
    const overlays: MobileRelayHostOverlay[] = []
    for (const item of value) {
      const result = MobileRelayHostOverlaySchema.safeParse(item)
      if (result.success) {
        overlays.push(result.data)
      }
    }
    return overlays
  } catch {
    return null
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
      await AsyncStorage.setItem(OVERLAY_STORAGE_KEY, serializeOverlays(next))
    }
  })
  overlayMutation = mutation.catch(() => {})
  return mutation
}

function serializeOverlays(overlays: MobileRelayHostOverlay[]): string {
  if (overlays.length > MOBILE_RELAY_HOST_OVERLAY_MAX_ENTRIES) {
    throw new Error('mobile relay host overlay count limit exceeded')
  }
  const serialized = JSON.stringify(overlays)
  if (serialized.length > MOBILE_RELAY_HOST_OVERLAY_MAX_STORAGE_CHARACTERS) {
    throw new Error('mobile relay host overlay storage limit exceeded')
  }
  return serialized
}

export async function loadMobileRelayHostOverlays(
  existingHostIds: ReadonlySet<string>
): Promise<Map<string, MobileRelayHostOverlay>> {
  return (await loadMobileRelayHostOverlayState(existingHostIds)).overlays
}

export async function loadMobileRelayHostOverlayState(
  existingHostIds: ReadonlySet<string>
): Promise<{ overlays: Map<string, MobileRelayHostOverlay>; orphanHostIds: string[] }> {
  await overlayMutation
  const overlays = parseOverlays(await AsyncStorage.getItem(OVERLAY_STORAGE_KEY)) ?? []
  const active = new Map<string, MobileRelayHostOverlay>()
  const orphanHostIds: string[] = []
  for (const overlay of overlays) {
    // Why: an older app can remove the legacy base without knowing this
    // namespace; never let the retained overlay resurrect that host later.
    if (existingHostIds.has(overlay.hostId)) {
      active.set(overlay.hostId, overlay)
    } else {
      orphanHostIds.push(overlay.hostId)
    }
  }
  return { overlays: active, orphanHostIds }
}

export async function saveMobileRelayHostOverlay(overlay: MobileRelayHostOverlay): Promise<void> {
  const validated = MobileRelayHostOverlaySchema.parse(overlay)
  return mutateOverlays((overlays) => {
    const index = overlays.findIndex(({ hostId }) => hostId === validated.hostId)
    if (index < 0) {
      return [...overlays, validated]
    }
    const next = overlays.slice()
    next[index] = validated
    return next
  })
}

export function removeMobileRelayHostOverlay(hostId: string): Promise<void> {
  return removeMobileRelayHostOverlays([hostId])
}

export function removeMobileRelayHostOverlays(hostIds: readonly string[]): Promise<void> {
  const targets = new Set(hostIds)
  let removed = false
  return mutateOverlays((overlays) => {
    const next = overlays.filter((overlay) => {
      if (!targets.has(overlay.hostId)) {
        return true
      }
      removed = true
      return false
    })
    return removed ? next : overlays
  })
}

/** Test-only: drain the module mutation chain between cases. */
export function resetMobileRelayHostOverlayStoreForTests(): void {
  overlayMutation = Promise.resolve()
}
