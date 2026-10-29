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
    // Never rewrite unreadable v2 data as empty; unrelated host edits must preserve relay recovery.
    throw new Error('mobile relay host overlay storage unreadable')
  }
  return overlays
}

async function mutateOverlays(
  update: (overlays: MobileRelayHostOverlay[]) => MobileRelayHostOverlay[]
): Promise<boolean> {
  const mutation = overlayMutation.then(async () => {
    const current = await readOverlaysForMutation()
    const next = update(current)
    // Skip storage for identity-preserving updates.
    if (next === current) {
      return false
    }
    await AsyncStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(next))
    return true
  })
  overlayMutation = mutation.then(
    () => {},
    () => {}
  )
  return mutation
}

export async function loadMobileRelayHostRoutingState(
  existingHostIds: ReadonlySet<string>
): Promise<{ relays: Map<string, MobileRelayEndpoint>; orphanHostIds: string[] }> {
  await overlayMutation
  const overlays = parseOverlays(await AsyncStorage.getItem(OVERLAY_STORAGE_KEY)) ?? []
  const relays = new Map<string, MobileRelayEndpoint>()
  const orphanHostIds: string[] = []
  for (const overlay of overlays) {
    // Older builds may remove base hosts without this namespace; retained overlays must not resurrect them.
    if (!existingHostIds.has(overlay.hostId)) {
      orphanHostIds.push(overlay.hostId)
    } else if (overlay.relay) {
      relays.set(overlay.hostId, overlay.relay)
    }
  }
  return { relays, orphanHostIds }
}

export function saveMobileRelayHostRouting(
  hostId: string,
  relay: MobileRelayEndpoint
): Promise<boolean> {
  const validated = toStoredMobileRelayHostOverlay(hostId, relay)
  return mutateOverlays((overlays) => {
    const index = overlays.findIndex((overlay) => overlay.hostId === hostId)
    if (index === -1) {
      return [...overlays, validated]
    }
    // Skip identical routing writes during repeated resolution; schema-normalized outputs have stable key order.
    if (JSON.stringify(overlays[index]) === JSON.stringify(validated)) {
      return overlays
    }
    const next = overlays.slice()
    next[index] = validated
    return next
  })
}

export function removeMobileRelayHostRouting(hostId: string): Promise<void> {
  return removeMobileRelayHostRoutings([hostId])
}

export async function removeMobileRelayHostRoutings(hostIds: readonly string[]): Promise<void> {
  const targets = new Set(hostIds)
  await mutateOverlays((overlays) => {
    const next = overlays.filter((overlay) => !targets.has(overlay.hostId))
    return next.length === overlays.length ? overlays : next
  })
}

export function resetMobileRelayHostOverlayStoreForTests(): void {
  overlayMutation = Promise.resolve()
}
