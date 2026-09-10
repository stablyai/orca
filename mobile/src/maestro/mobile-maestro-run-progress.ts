import { z } from 'zod'
import {
  MaestroRunProgressSummarySchema,
  MaestroRunProgressV2Schema,
  type MaestroRunProgress,
  type MaestroRunProgressV2
} from '../../../src/shared/maestro-run-progress'

const MaestroRunProgressAuthoritySchema = z
  .object({
    runId: z.string(),
    workspace: z.object({ executionHostId: z.string(), workspaceKey: z.string() }).strict(),
    revision: z.number().int().nonnegative()
  })
  .strict()

const LegacyMaestroRunProgressSchema = z.union([
  z.object({ available: z.literal(false), state: z.literal('outcome_unknown') }).strict(),
  z
    .object({
      available: z.literal(true),
      summary: MaestroRunProgressSummarySchema,
      authority: MaestroRunProgressAuthoritySchema
    })
    .strict()
])

const MaestroRunProgressRpcResultSchema = z.discriminatedUnion('schemaVersion', [
  z.object({ schemaVersion: z.literal(2), progress: MaestroRunProgressV2Schema }).strict(),
  z.object({ schemaVersion: z.literal(1), progress: LegacyMaestroRunProgressSchema }).strict(),
  z.object({ schemaVersion: z.null(), progress: z.null() }).strict()
])

export type MobileMaestroRunProgress =
  | { schemaVersion: 2; progress: MaestroRunProgressV2 }
  | { schemaVersion: 1; progress: MaestroRunProgress }

export function parseMobileMaestroRunProgressRpcResult(
  value: unknown
): MobileMaestroRunProgress | null {
  const parsed = MaestroRunProgressRpcResultSchema.safeParse(value)
  if (!parsed.success || parsed.data.schemaVersion === null) {
    return null
  }
  return parsed.data
}

export function parseLegacyMobileMaestroRunProgress(
  value: unknown
): MobileMaestroRunProgress | null {
  const parsed = LegacyMaestroRunProgressSchema.safeParse(value)
  return parsed.success ? { schemaVersion: 1, progress: parsed.data } : null
}
