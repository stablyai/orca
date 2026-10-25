import { execFile, type ChildProcess } from 'node:child_process'
import {
  PORT_SCAN_COMMAND_TIMEOUT_MS,
  PortScanCommandTimeoutError,
  WATCHDOG_GRACE_MS,
  portScanCommandTimeoutMessage
} from './port-scan-command-protocol'

// Worker-only: EDR hooks can block inline uv_spawn; main-thread imports would reintroduce UI freezes (#11161).

const WATCHDOG_TIMEOUT_MS = PORT_SCAN_COMMAND_TIMEOUT_MS + WATCHDOG_GRACE_MS

const activeChildren = new Set<ChildProcess>()

/** Measure spawn separately; execution beyond its budget throws PortScanCommandTimeoutError. */
export async function runPortScanCommandInProcess(
  command: string,
  args: string[]
): Promise<{ stdout: string; spawnMs: number }> {
  return await new Promise((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | null = null
    let spawnMs = 0
    let child: ChildProcess | undefined

    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      if (child) {
        activeChildren.delete(child)
      }
      callback()
    }

    const startedAt = Date.now()
    try {
      child = execFile(
        command,
        args,
        {
          timeout: PORT_SCAN_COMMAND_TIMEOUT_MS,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true
        },
        (error, stdout) => {
          if (error) {
            // execFile timeout kills the child; use its killed flag to classify the failure.
            const timedOut = (error as { killed?: boolean }).killed === true
            settle(() =>
              reject(
                timedOut
                  ? new PortScanCommandTimeoutError(
                      portScanCommandTimeoutMessage(command, PORT_SCAN_COMMAND_TIMEOUT_MS)
                    )
                  : error
              )
            )
            return
          }
          settle(() => resolve({ stdout: String(stdout), spawnMs }))
        }
      )
    } catch (error) {
      settle(() => reject(error))
      return
    }

    // Arm after execFile returns so inline spawn stalls do not consume the execution budget (#11161).
    spawnMs = Date.now() - startedAt
    if (settled || !child) {
      return
    }
    activeChildren.add(child)
    timer = setTimeout(() => {
      settle(() => {
        child?.kill()
        reject(
          new PortScanCommandTimeoutError(
            portScanCommandTimeoutMessage(command, WATCHDOG_TIMEOUT_MS)
          )
        )
      })
    }, WATCHDOG_TIMEOUT_MS)
  })
}

/** Best-effort reap so a terminated worker does not orphan an in-flight probe. */
export function killActivePortScanCommands(): void {
  for (const child of activeChildren) {
    try {
      child.kill()
    } catch {
      // Already exited; nothing to reap.
    }
  }
  activeChildren.clear()
}
