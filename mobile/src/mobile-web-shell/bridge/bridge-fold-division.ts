import { z } from 'zod'
import { BRIDGE_MAX_SAFE_AREA_INSET } from './bridge-safe-area-insets'

const offsetSchema = z.number().finite().min(0).max(BRIDGE_MAX_SAFE_AREA_INSET)

/**
 * The band a partially folded device's fold takes out of the page, in the page's own px: from
 * `start` to `end` across the width (`vertical`, book posture) or the height (`horizontal`,
 * tabletop posture). The page lays its panes out either side of it. Optional and additive: absent
 * reads as no fold, which is every device that does not fold and every shell older than the field.
 */
export const BridgeFoldDivisionSchema = z
  .object({
    axis: z.enum(['vertical', 'horizontal']),
    start: offsetSchema,
    end: offsetSchema
  })
  .refine((division) => division.end > division.start, 'Expected end after start')

export type BridgeFoldDivision = z.infer<typeof BridgeFoldDivisionSchema>

export function sameFoldDivision(
  left: BridgeFoldDivision | null,
  right: BridgeFoldDivision | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.axis === right.axis &&
      left.start === right.start &&
      left.end === right.end)
  )
}
