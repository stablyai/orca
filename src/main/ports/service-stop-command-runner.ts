import { execFile } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 4_000

class CommandTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`${command} timed out after ${timeoutMs}ms`)
    this.name = 'CommandTimeoutError'
  }
}

/**
 * Run a command with a caller-chosen wall-clock bound.
 *
 * Why this stays off the scan worker (port-scan-command-client): stopping a
 * service is a one-shot user action whose budget varies per command —
 * `docker stop` waits out a container's grace period and needs far longer than
 * the worker's fixed 4s — and it must not queue behind a periodic scan on that
 * worker's one-at-a-time FIFO.
 *
 * Why the manual timer rather than execFile's `timeout` alone: Node's option
 * only signals the child. If the callback never arrives (a wedged daemon
 * holding the pipe open is the case that bit us), the caller would hang
 * forever. The timer guarantees the promise settles.
 */
export function runBoundedCommand(
  command: string,
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    let child: ReturnType<typeof execFile> | undefined
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child?.kill()
      reject(new CommandTimeoutError(command, timeoutMs))
    }, timeoutMs)

    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      callback()
    }

    try {
      child = execFile(
        command,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true
        },
        (error, stdout) => {
          if (error) {
            settle(() => reject(error))
            return
          }
          settle(() => resolve({ stdout: String(stdout) }))
        }
      )
    } catch (error) {
      settle(() => reject(error))
    }
  })
}
