import AsyncStorage from '@react-native-async-storage/async-storage'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import {
  MobileRelayHostOverlaySchema,
  toStoredMobileRelayHostOverlay,
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
    const next = update(current)
    // Why: direct-only saves commonly have no overlay to remove; avoid a full
    // AsyncStorage write when cleanup leaves the durable list unchanged.
    if (next !== current) {
      await AsyncStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(next))
    }
  })
  overlayMutation = mutation.catch(() => {})
  return mutation
}

export async function loadMobileRelayHostOverlayState(
  existingHostIds: ReadonlySet<string>
): Promise<{ relays: Map<string, MobileRelayEndpoint>; orphanHostIds: string[] }> {
  await overlayMutation
  const overlays = parseOverlays(await AsyncStorage.getItem(OVERLAY_STORAGE_KEY)) ?? []
  const relays = new Map<string, MobileRelayEndpoint>()
  const orphanHostIds: string[] = []
  for (const overlay of overlays) {
    // Why: an older app can remove the legacy base without knowing this
    // namespace; never let the retained overlay resurrect that host later.
    if (!existingHostIds.has(overlay.hostId)) {
      orphanHostIds.push(overlay.hostId)
    } else if (overlay.relay) {
      relays.set(overlay.hostId, overlay.relay)
    }
  }
  return { relays, orphanHostIds }
}

/** Resolves whether storage changed. */
export async function saveMobileRelayHostRouting(
  hostId: string,
  relay: MobileRelayEndpoint
): Promise<boolean> {
  const validated = toStoredMobileRelayHostOverlay(hostId, relay)
  let wrote = false
  await mutateOverlays((overlays) => {
    const index = overlays.findIndex((overlay) => overlay.hostId === hostId)
    if (index === -1) {
      wrote = true
      return [...overlays, validated]
    }
    // Why: a failing relay loop re-resolves the same cell every retry. Both sides are this
    // schema's output, so key order matches; an older record's direct entry fails the compare.
    if (JSON.stringify(overlays[index]) === JSON.stringify(validated)) {
      return overlays
    }
    wrote = true
    const next = overlays.slice()
    next[index] = validated
    return next
  })
  return wrote
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
