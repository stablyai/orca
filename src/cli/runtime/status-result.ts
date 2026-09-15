import { z } from 'zod'
import { RuntimeClientError } from './types'

// Validate projection inputs; additive host fields and open capability vocabularies survive.
const statusResultSchema = z
  .object({
    runtimeId: z.string().min(1),
    graphStatus: z.enum(['ready', 'reloading', 'unavailable']),
    authoritativeWindowId: z.number().int().nonnegative().nullable(),
    desktopWindowStatus: z.enum(['available', 'openable', 'initializing', 'blocked']).optional(),
    appVersion: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    degradations: z
      .array(
        z
          .object({
            code: z.string(),
            capability: z.string(),
            message: z.string(),
            reason: z.string().optional(),
            detail: z.string().optional()
          })
          .passthrough()
      )
      .optional(),
    remoteUpdateSupport: z
      .object({
        installMode: z.string(),
        automatic: z.boolean(),
        reason: z.string()
      })
      .passthrough()
      .optional(),
    remoteControl: z.object({ state: z.string() }).passthrough().nullable().optional()
  })
  .passthrough()

export function validateStatusResult(result: unknown, runtimeId: string): void {
  const parsed = statusResultSchema.safeParse(result)
  if (!parsed.success) {
    throw new RuntimeClientError(
      'invalid_runtime_response',
      'The Orca runtime returned invalid status data.',
      {
        transportFailure: { outcome: 'invalid_response' }
      }
    )
  }
  if (parsed.data.runtimeId !== runtimeId) {
    throw new RuntimeClientError(
      'runtime_unavailable',
      'The Orca runtime changed while observing status.',
      {
        transportFailure: { outcome: 'identity_changed' }
      }
    )
  }
}
