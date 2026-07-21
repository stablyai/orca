import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import { petPresenceAuthority } from '../../../pet/pet-presence-authority'

/**
 * Pet presence RPC (P1) — how desktop renderers, popouts and phones read and
 * influence pet presence without ever writing it themselves.
 *
 * The authority is the single writer; every method here either reads a snapshot
 * or reports an intent that the authority is free to reject. `pet.reportExit`
 * in particular is a REQUEST, not a command: a surface that no longer holds the
 * pet gets the current snapshot back rather than moving anything.
 */

let petSubscriptionSeq = 0

const SurfaceKind = z.enum(['desktop-window', 'popout-window', 'phone'])
const SurfaceId = z.string().min(1, 'Missing surfaceId').max(200)
const Edge = z.enum(['left', 'right', 'top', 'bottom'])

const RegisterSurfaceParams = z.object({
  surfaceId: SurfaceId,
  kind: SurfaceKind
})

const SurfaceOnlyParams = z.object({ surfaceId: SurfaceId })

const ReportExitParams = z.object({
  surfaceId: SurfaceId,
  edge: Edge,
  // Normalized 0..1; clamped again inside the pure layer so a malformed client
  // cannot push the pet off-surface.
  position: z.object({ x: z.number(), y: z.number() })
})

const UnsubscribeParams = z.object({
  subscriptionId: z.string().min(1, 'Missing subscriptionId')
})

export const PET_PRESENCE_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'pet.getState',
    params: null,
    handler: async () => petPresenceAuthority.getState()
  }),
  defineMethod({
    // Also the heartbeat: calling it again refreshes `seenAt`, which is what
    // keeps a surface from being swept as stale.
    name: 'pet.registerSurface',
    params: RegisterSurfaceParams,
    handler: async (params) =>
      petPresenceAuthority.registerSurface(params.surfaceId, params.kind)
  }),
  defineMethod({
    name: 'pet.removeSurface',
    params: SurfaceOnlyParams,
    handler: async (params) => {
      petPresenceAuthority.removeSurface(params.surfaceId)
      return petPresenceAuthority.getState()
    }
  }),
  defineMethod({
    name: 'pet.reportExit',
    params: ReportExitParams,
    handler: async (params) =>
      petPresenceAuthority.reportExit(params.surfaceId, params.edge, params.position)
  }),
  defineMethod({
    name: 'pet.acknowledgeEntry',
    params: SurfaceOnlyParams,
    handler: async (params) => petPresenceAuthority.acknowledgeEntry(params.surfaceId)
  }),
  defineMethod({
    name: 'pet.claim',
    params: SurfaceOnlyParams,
    handler: async (params) => petPresenceAuthority.claim(params.surfaceId)
  }),
  defineStreamingMethod({
    name: 'pet.subscribe',
    params: null,
    handler: async (_params, { runtime, connectionId }, emit) => {
      await new Promise<void>((resolve) => {
        const unsubscribe = petPresenceAuthority.subscribe((snapshot) => {
          emit({ type: 'presence', ...snapshot })
        })

        const seq = ++petSubscriptionSeq
        const subscriptionId = `pet-presence-${connectionId ?? 'inproc'}-${seq}`
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )

        // Why emit current state immediately: a subscriber that only ever hears
        // about CHANGES would render nothing until the pet happened to move.
        emit({ type: 'ready', subscriptionId })
        emit({ type: 'presence', ...petPresenceAuthority.getState() })
      })
    }
  }),
  defineMethod({
    name: 'pet.unsubscribe',
    params: UnsubscribeParams,
    handler: async (params, { runtime, connectionId }) => {
      // Why the prefix check: subscription ids are guessable, and without this
      // one connection could cancel another's stream. Mirrors
      // runtime.clientEvents.unsubscribe.
      const expectedPrefix = `pet-presence-${connectionId ?? 'inproc'}-`
      if (!params.subscriptionId.startsWith(expectedPrefix)) {
        return { unsubscribed: false }
      }
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
