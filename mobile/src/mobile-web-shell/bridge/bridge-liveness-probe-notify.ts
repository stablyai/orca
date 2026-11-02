import { z } from 'zod'

// The page asks native for a decisive liveness probe when its replies stop coming. Older shells refuse the frame with a diagnostic only and keep the idle watchdog.
export const BRIDGE_LIVENESS_PROBE_NOTIFY = 'liveness-probe'

export const BRIDGE_LIVENESS_PROBE_NOTIFY_FIELDS = {
  type: z.literal('notify'),
  name: z.literal(BRIDGE_LIVENESS_PROBE_NOTIFY)
}
