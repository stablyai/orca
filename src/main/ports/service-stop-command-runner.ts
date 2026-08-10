import { execFile } from 'node:child_process'

const DEFAULT_TIMEOUT_MS = 4_000

class CommandTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`${command} timed out after ${timeoutMs}ms`)
    this.name = 'CommandTimeoutError'
  }
}

/**
 * Run a stop command off the scan worker with a caller-set budget: `docker stop`
 * waits out a container's grace period, far past the worker's fixed 4s, and a
 * user action must not queue behind a periodic scan.
 *
 * The manual timer is the backstop for execFile never calling back.
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
