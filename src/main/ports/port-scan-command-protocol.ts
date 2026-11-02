// Keep worker/client protocol free of Electron, worker_threads and child_process imports.

export const PORT_SCAN_COMMAND_TIMEOUT_MS = 4_000
// The fallback watchdog must follow Node's primary execFile timeout.
export const WATCHDOG_GRACE_MS = 1_000

export type DarwinPortScanOperation = 'listeners' | 'attribution'

export type PortScanCommandRequest = {
  id: number
  command: string
  args: string[]
  darwinOperation?: DarwinPortScanOperation
}

export type PortScanCommandResponse =
  | { id: number; ok: true; stdout: string; spawnMs: number }
  | { id: number; ok: false; timedOut: boolean; error: string }

/** Error subclasses do not survive structured clone; reconstruct this from the worker's timedOut flag. */
export class PortScanCommandTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortScanCommandTimeoutError'
  }
}

export function portScanCommandTimeoutMessage(command: string, timeoutMs: number): string {
  return `${command} timed out after ${timeoutMs}ms`
}
