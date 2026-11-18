import { appendFileSync, renameSync, statSync } from 'node:fs'

const LOG_MAX_BYTES = 256 * 1024

/**
 * Worker threads only, before posting a rare large message: written synchronously so the line
 * survives the receiving thread aborting or hanging on that message. One rotated file, bounded.
 */
export function appendWorkerLargeSend(path: string, record: Record<string, unknown>): void {
  if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > LOG_MAX_BYTES) {
    renameSync(path, `${path}.1`)
  }
  appendFileSync(path, `${JSON.stringify(record)}\n`)
}
