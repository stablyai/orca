import { logStartupMilestone } from '../../../startup/diagnostics/startup-diagnostics'

export function parseProfileStateInput(
  serialized: string | undefined,
  parsedInput: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const readStartedAt = performance.now()
  const raw = parsedInput === undefined ? serialized : undefined
  if (raw === undefined) {
    return parsedInput
  }
  logStartupMilestone('persistence-read-done', {
    bytes: Buffer.byteLength(raw),
    durationMs: Math.round(performance.now() - readStartedAt)
  })
  logStartupMilestone('persistence-json-parse-start')
  const parsed = JSON.parse(raw)
  logStartupMilestone('persistence-json-parse-done')
  return parsed
}
