// Values a dock row reads from its Dispatch: launch options and stored timestamps.
import { z } from 'zod'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'
import { exposeUtcTimestamp } from '../db/utc-timestamp'

export function epoch(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value !== 'string') {
    return null
  }
  const ms = Date.parse(exposeUtcTimestamp(value) ?? '')
  return Number.isFinite(ms) ? ms : null
}
const Launch = lazyZodSchema(() =>
  z.object({
    name: z.string().nullable().optional(),
    launch: z.unknown().optional(),
    agent: z.string().nullable().optional()
  })
)
export function launchOptions(value: unknown): z.infer<typeof Launch> {
  try {
    return Launch.parse(JSON.parse(typeof value === 'string' ? value : '{}'))
  } catch {
    return {}
  }
}
