import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcSuccess } from '../transport/types'
import {
  clamp01,
  initialPresence,
  type PetEdge,
  type PetPoint,
  type PetPresenceSnapshot
} from '../../../src/shared/pet-presence'

// P4: the phone as a pet surface.
//
// Registers this device with the desktop's presence authority over the same
// authenticated RPC connection everything else uses, mirrors state, and reports
// edge exits so the pet can walk back to the desktop. The phone never writes
// position — the authority on node-b is the single writer, and a phone that
// decided where the pet was would be a second writer by another name.

/** Comfortably inside SURFACE_STALE_AFTER_MS (30s) so a brief network stall
 *  cannot get a live phone swept out from under the pet. */
const HEARTBEAT_MS = 8_000

/** Poll cadence for presence. The desktop pushes changes over pet.subscribe;
 *  this is the reconnect-safety net, not the primary path. */
const POLL_MS = 6_000

/**
 * One surface id per APP RUN, not per component mount.
 *
 * Why module-level: the overlay unmounts and remounts on every navigation. A
 * per-mount id meant each remount registered a NEW surface while the authority
 * still considered the previous one alive for its full 30s stale window — so
 * the pet stayed stranded on an id nothing was rendering, and the phone drew
 * nothing. Observed live 2026-07-21: the authority held
 * `phone-mrur90ht-5jirsu` while the mounted component was asking about a
 * different id entirely.
 *
 * The device is the surface. Its identity must outlive any one screen.
 */
const SURFACE_ID = `phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export type MobilePetPresence = {
  /** True when this phone should be drawing the pet. */
  holdsPet: boolean
  /** WHICH pet the authority says is travelling, or null before it has said. */
  petId: string | null
  position: PetPoint
  facing: 'left' | 'right'
  enteredFromEdge: PetEdge | null
  /** True when somewhere else exists to hand the pet to. */
  canHandOff: boolean
  reportExit: (edge: PetEdge, position: PetPoint) => void
  acknowledgeEntry: () => void
}

export function useMobilePetPresence(options: {
  client: RpcClient | null
  enabled: boolean
  /**
   * Pet ids this phone actually has sheets for. Sent with every heartbeat so
   * the authority never hands the pet to a device that would draw a different
   * creature — a custom pet that was not bundled simply stays on the desktop.
   */
  renderablePetIds: string[]
}): MobilePetPresence {
  const { client, enabled, renderablePetIds } = options
  // Stringified so a fresh array literal from the caller does not restart the
  // heartbeat on every render.
  const renderableKey = renderablePetIds.join(',')
  const surfaceIdRef = useRef<string>(SURFACE_ID)
  const [snapshot, setSnapshot] = useState<PetPresenceSnapshot>(() => ({
    presence: initialPresence(Date.now()),
    surfaces: []
  }))
  // Why: until the authority answers, the phone must NOT claim the pet. This is
  // the mirror image of the desktop's optimistic default and the reason is the
  // same bug seen in P2 — but inverted. On the desktop, assuming "not mine"
  // hid the pet everywhere; on the phone, assuming "mine" would duplicate it
  // onto every device before the desktop got a word in.
  const [authorityAnswered, setAuthorityAnswered] = useState(false)
  const exitPendingRef = useRef(false)

  const apply = useCallback((next: PetPresenceSnapshot) => {
    setSnapshot(next)
    setAuthorityAnswered(true)
  }, [])

  const call = useCallback(
    async (method: string, params: Record<string, unknown>): Promise<void> => {
      if (!client) {
        return
      }
      try {
        const response = await client.sendRequest(method, params)
        if (response.ok) {
          // Unwrap `.result`: sendRequest resolves the RPC envelope, not the
          // payload. Reading the envelope directly is what silently broke
          // session speak-back — keep the hop explicit.
          apply((response as RpcSuccess).result as PetPresenceSnapshot)
        }
      } catch {
        // A dropped call is not worth surfacing; the heartbeat retries.
      }
    },
    [client, apply]
  )

  useEffect(() => {
    if (!enabled || !client) {
      return
    }
    const surfaceId = surfaceIdRef.current
    let disposed = false

    const beat = (): void => {
      if (!disposed) {
        void call('pet.registerSurface', {
          surfaceId,
          kind: 'phone',
          renderablePetIds: renderableKey === '' ? [] : renderableKey.split(',')
        })
      }
    }
    beat()
    const heartbeat = setInterval(beat, HEARTBEAT_MS)
    const poll = setInterval(() => {
      if (!disposed) {
        void call('pet.getState', {})
      }
    }, POLL_MS)

    return () => {
      disposed = true
      clearInterval(heartbeat)
      clearInterval(poll)
      // Leaving the screen hands the pet back immediately rather than stranding
      // it on a phone for the full stale window.
      void call('pet.removeSurface', { surfaceId })
    }
  }, [enabled, client, call, renderableKey])

  const reportExit = useCallback(
    (edge: PetEdge, position: PetPoint) => {
      // In-flight guard: the roam loop runs every frame and would otherwise fire
      // a burst of exits while the pet sits against the edge awaiting an answer.
      if (exitPendingRef.current) {
        return
      }
      exitPendingRef.current = true
      void call('pet.reportExit', {
        surfaceId: surfaceIdRef.current,
        edge,
        position: { x: clamp01(position.x), y: clamp01(position.y) }
      }).finally(() => {
        exitPendingRef.current = false
      })
    },
    [call]
  )

  const acknowledgeEntry = useCallback(() => {
    void call('pet.acknowledgeEntry', { surfaceId: surfaceIdRef.current })
  }, [call])

  const surfaceId = surfaceIdRef.current
  const { presence, surfaces } = snapshot
  return {
    holdsPet: authorityAnswered && presence.surfaceId === surfaceId,
    petId: presence.petId,
    position: presence.position,
    facing: presence.facing,
    enteredFromEdge: presence.enteredFromEdge,
    canHandOff: surfaces.some((surface) => surface.id !== surfaceId),
    reportExit,
    acknowledgeEntry
  }
}
