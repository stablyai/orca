// Why (#11161): request/response shapes plus the timeout error shared by the
// port-scan worker entry and its main-thread client. Kept free of Electron,
// node:worker_threads and node:child_process so importing it from either side
// can never drag the other side's dependencies across the boundary.

export const PORT_SCAN_COMMAND_TIMEOUT_MS = 4_000
// Node's own execFile timeout is the primary killer; the manual watchdog only
// covers "the callback never arrived", so it must fire strictly later.
export const WATCHDOG_GRACE_MS = 1_000

export type PortScanCommandRequest = {
  id: number
  command: string
  args: string[]
}

export type PortScanCommandResponse =
  | { id: number; ok: true; stdout: string; spawnMs: number }
  | { id: number; ok: false; timedOut: boolean; error: string }

/**
 * Raised when a port-scan command was killed after exceeding its budget. Errors
 * do not survive structured clone as subclasses, so the worker reports a
 * `timedOut` flag and the client reconstructs this type from it.
 */
export class PortScanCommandTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortScanCommandTimeoutError'
  }
}

/** Shared wording so worker-side and client-side timeouts read identically. */
export function portScanCommandTimeoutMessage(command: string, timeoutMs: number): string {
  return `${command} timed out after ${timeoutMs}ms`
}
