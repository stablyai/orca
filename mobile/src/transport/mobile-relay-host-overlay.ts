import { z } from 'zod'
import { MobileRelayEndpointSchema } from '../../../src/shared/mobile-relay-credential-contract'
import { t } from '@/i18n/mobile-i18n'

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
      context.addIssue({
        code: 'custom',
        message: t('mobileRelayHostOverlay.relayIdentity')
      })
      return
    }
    if (overlay.relay && overlay.relay.relayHostId !== overlay.relayHostId) {
      context.addIssue({
        code: 'custom',
        path: ['relayHostId'],
        message: t('mobileRelayHostOverlay.relayHost')
      })
    }
    const relayEndpointCount = overlay.endpoints.filter(({ kind }) => kind === 'relay').length
    if (relayEndpointCount !== (overlay.relay ? 1 : 0)) {
      context.addIssue({
        code: 'custom',
        path: ['endpoints'],
        message: t('mobileRelayHostOverlay.expected')
      })
    }
  })

export type MobileAccessEndpoint = z.infer<typeof MobileAccessEndpointSchema>
export type MobileRelayHostOverlay = z.infer<typeof MobileRelayHostOverlaySchema>
