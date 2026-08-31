import { z } from 'zod'
import { requiredString } from '../../schemas'

const TerminalHandle = z.object({ terminal: requiredString('Missing terminal handle') })

export const TerminalSetDisplayMode = TerminalHandle.extend({
  // Why: 'auto' = mobile drives dims while subscribed (desktop restores on last-leave); 'desktop' = no resize, mobile scales to fit.
  mode: z.enum(['auto', 'desktop']),
  // Why: identifies the caller for the driver state machine; optional for older mobile clients.
  client: z
    .object({
      id: requiredString('Missing client ID'),
      type: z.enum(['mobile', 'desktop']).default('desktop').optional()
    })
    .optional(),
  // Why: carries the measured viewport so an 'auto' toggle on a viewport-less record can phone-fit instead of no-op'ing.
  viewport: z
    .object({
      cols: z.number().int().positive(),
      rows: z.number().int().positive()
    })
    .optional()
})

export const TerminalUnsubscribe = z.object({
  subscriptionId: requiredString('Missing subscription ID'),
  // Why: lets the server rebuild the composite `${terminal}:${clientId}` cleanup key when older clients pass a bare subscriptionId (docs/mobile-presence-lock.md).
  client: z
    .object({
      id: requiredString('Missing client ID')
    })
    .optional()
})

// Why: in-place update avoids an unsubscribe→resubscribe that flashed the lock banner and stranded the PTY at phone dims (docs/mobile-presence-lock.md).
export const TerminalUpdateViewport = TerminalHandle.extend({
  client: z.object({
    id: requiredString('Missing client ID'),
    type: z.enum(['mobile', 'desktop']).default('mobile').optional()
  }),
  viewport: z.object({
    cols: z.number().int().min(20).max(240),
    rows: z.number().int().min(8).max(120)
  }),
  claim: z.boolean().optional()
})

// Why: phone-fit auto-restore preference (docs/mobile-fit-hold.md); `null` = Indefinite, finite ms clamped to [5_000, 60min] server-side.
export const TerminalSetAutoRestoreFit = z.object({
  ms: z.number().nullable()
})
