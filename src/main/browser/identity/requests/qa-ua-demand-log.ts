import { appendFileSync } from 'node:fs'
// QA-only diagnostic (never merged): JSON lines to ORCA_QA_UA_DEMAND_LOG.
export function qaUaDemandLog(event: string, data: Record<string, unknown>): void {
  const path = process.env.ORCA_QA_UA_DEMAND_LOG
  if (!path) {
    return
  }
  try {
    appendFileSync(path, `${JSON.stringify({ at: Date.now(), event, ...data })}\n`)
  } catch {}
}
