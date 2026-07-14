import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  MobileRelayHostOverlaySchema,
  type MobileRelayHostOverlay
} from './mobile-relay-host-overlay'

const OVERLAY_STORAGE_KEY = 'orca:mobile-relay:host-overlays:v2'
let overlayMutation: Promise<void> = Promise.resolve()

function parseOverlays(raw: string | null): MobileRelayHostOverlay[] | null {
  if (raw === null) {
    return []
  }
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) {
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
    await AsyncStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(update(current)))
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
  return mutateOverlays((overlays) => overlays.filter((overlay) => overlay.hostId !== hostId))
}

/** Test-only: drain the module mutation chain between cases. */
export function resetMobileRelayHostOverlayStoreForTests(): void {
  overlayMutation = Promise.resolve()
}
