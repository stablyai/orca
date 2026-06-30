import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { z } from 'zod'
import { ALL_SCRYER_OPERATION_IDS } from './catalog'
import type { ScryerOperationResult } from './types'

const operationIdSchema = z.enum(ALL_SCRYER_OPERATION_IDS)

export const parityFixtureSchema = z
  .object({
    operationId: operationIdSchema,
    upstreamCommit: z.string().min(7),
    upstreamAnchors: z.array(z.string().min(1)).min(1),
    input: z.unknown(),
    context: z.record(z.string(), z.unknown()).default({}),
    expected: z.union([z.literal('success'), z.literal('failure')]),
    orcaDifferenceReason: z.string().min(1),
    result: z.unknown().optional(),
    goldenState: z.record(z.string(), z.unknown()).optional()
  })
  .strict()

export type ScryerParityFixture = z.infer<typeof parityFixtureSchema>

export async function loadParityFixture(filePath: string): Promise<ScryerParityFixture> {
  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  return parityFixtureSchema.parse(parsed)
}

function scrubString(value: string): string {
  const tempRoot = resolve('/tmp')
  if (value.startsWith(tempRoot)) {
    return '<tmp-path>'
  }
  if (value.startsWith('/')) {
    return '<abs-path>'
  }
  if (/^req-[A-Za-z0-9_-]+$/.test(value) || /^scryer-[A-Za-z0-9_-]+$/.test(value)) {
    return '<request-id>'
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
    return '<timestamp>'
  }
  return value
}

export function scrubParityValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return scrubString(value)
  }
  if (Array.isArray(value)) {
    return value.map(scrubParityValue)
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'requestId' || key === 'timestamp' || key === 'reconciledAt'
          ? `<${key}>`
          : scrubParityValue(item)
      ])
    )
  }
  return value
}

export function assertParityEnvelopeShape(
  fixture: ScryerParityFixture,
  result: ScryerOperationResult
): void {
  if (fixture.expected === 'success' && result.ok !== true) {
    throw new Error(`Parity fixture ${fixture.operationId} expected ok:true`)
  }
  if (fixture.expected === 'failure' && result.ok !== false) {
    throw new Error(`Parity fixture ${fixture.operationId} expected ok:false`)
  }
}
