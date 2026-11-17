import { z } from 'zod'
import {
  providerDiagnostic,
  type ProviderDiagnostic
} from '../../shared/agent-session/failures/agent-session-failure'

export const traexRecordSchema = z.record(z.string(), z.unknown())
export const traexItemSchema = z.looseObject({ id: z.string(), type: z.string() })
export type TraexItem = z.infer<typeof traexItemSchema>

export const traexTurnSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  items: z.array(traexItemSchema).optional(),
  startedAt: z.number().nullish(),
  completedAt: z.number().nullish(),
  durationMs: z.number().nullish()
})
export type TraexTurn = z.infer<typeof traexTurnSchema>

export const traexThreadResponseSchema = z.looseObject({
  thread: z.looseObject({
    id: z.string(),
    path: z.string().nullish(),
    historyMode: z.string().optional(),
    turns: z.array(traexTurnSchema).optional()
  }),
  model: z.string().optional(),
  reasoningEffort: z.string().nullish()
})

export function traexRecord(value: unknown): Record<string, unknown> {
  return traexRecordSchema.safeParse(value).data ?? {}
}

export function traexText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function traexNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function traexTimestampMs(value: unknown): number | undefined {
  const seconds = traexNonnegativeNumber(value)
  return seconds === undefined ? undefined : traexNonnegativeNumber(seconds * 1000)
}

export function traexContentText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return Array.isArray(value)
    ? value.flatMap((part) => traexText(part) ?? traexText(traexRecord(part).text) ?? []).join('\n')
    : ''
}

export class TraexRequestError extends Error {
  readonly providerDiagnostic: ProviderDiagnostic | undefined

  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'TraexRequestError'
    this.providerDiagnostic = providerDiagnostic(message, 'person')
  }
}
