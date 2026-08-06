import { execFile, type ChildProcess } from 'node:child_process'
import {
  PORT_SCAN_COMMAND_TIMEOUT_MS,
  PortScanCommandTimeoutError,
  WATCHDOG_GRACE_MS,
  portScanCommandTimeoutMessage
} from './port-scan-command-protocol'

// Why (#11161): libuv runs uv_spawn inline on whichever event loop calls it, so
// an endpoint-security hook on CreateProcessW stalls that thread for the whole
// spawn. This module is only ever entered from the worker thread
// (port-scan-command-worker-entry.ts); nothing on the main thread may import it.

const WATCHDOG_TIMEOUT_MS = PORT_SCAN_COMMAND_TIMEOUT_MS + WATCHDOG_GRACE_MS

const activeChildren = new Set<ChildProcess>()

/**
 * Run a port-scan probe command and report how long process creation took.
 * @param command - Executable name resolved against the worker's PATH.
 * @param args - Argument vector passed verbatim, never shell-interpolated.
 * @returns The command's stdout plus `spawnMs`, the measured process-creation
 *   latency callers use to skip optional follow-up commands on a stalled host.
 * @throws PortScanCommandTimeoutError when the command itself outran its budget.
 */
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
            // Node kills its own execFile timeout with a signal, which surfaces
            // as killed:true — the only way to tell a timeout from a real error.
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

    // Why (#11161): measured after execFile returns, because that call blocks
    // for the whole of process creation. Arming the watchdog earlier would
    // charge the spawn stall against the command's budget and fire immediately.
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
