import { z } from 'zod'
import { MobileRelayEndpointSchema } from '../../../src/shared/mobile-relay-credential-contract'
import type { HostProfile } from './types'

export const MobileAccessEndpointSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.enum(['lan', 'tailscale', 'relay']),
    url: z.string().min(1).max(2048)
  })
  .strict()

export const MobileRelayHostOverlaySchema = z
  .object({
    v: z.literal(2),
    hostId: z.string().min(1),
    // Why: absence preserves the released direct/Relay strategy for old profiles.
    routeOrder: z.literal(1).optional(),
    endpoints: z.array(MobileAccessEndpointSchema).min(1).max(16),
    relayHostId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{16}$/)
      .optional(),
    relay: MobileRelayEndpointSchema.optional()
  })
  .strict()
  .superRefine((overlay, context) => {
    if ((overlay.relayHostId === undefined) !== (overlay.relay === undefined)) {
      context.addIssue({ code: 'custom', message: 'Relay identity and endpoint must coexist' })
      return
    }
    if (overlay.relay && overlay.relay.relayHostId !== overlay.relayHostId) {
      context.addIssue({
        code: 'custom',
        path: ['relayHostId'],
        message: 'Relay host identity mismatch'
      })
    }
    const relayEndpointCount = overlay.endpoints.filter(({ kind }) => kind === 'relay').length
    if (relayEndpointCount !== (overlay.relay ? 1 : 0)) {
      context.addIssue({
        code: 'custom',
        path: ['endpoints'],
        message: 'Expected exactly one endpoint for configured relay metadata'
      })
    }
  })

export type MobileAccessEndpoint = z.infer<typeof MobileAccessEndpointSchema>
export type MobileRelayHostOverlay = z.infer<typeof MobileRelayHostOverlaySchema>

export function mobileRelayHostOverlayFromProfile(host: HostProfile): MobileRelayHostOverlay {
  return MobileRelayHostOverlaySchema.parse({
    v: 2,
    hostId: host.id,
    routeOrder: host.routeOrder,
    endpoints: host.endpoints,
    relayHostId: host.relayHostId,
    relay: host.relay
  })
}
