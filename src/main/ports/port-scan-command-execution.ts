import { execFile, type ChildProcess } from 'node:child_process'
import { closeSync } from 'node:fs'
import { spawnProcess } from '@orca/process-host'
import { LSOF_NONBLOCKING_ARGS } from '../../shared/lsof-nonblocking-args'
import { DarwinNetstatListeners } from './darwin-netstat-listeners'
import { openDarwinPortScanLock } from './darwin-port-scan-lock'
import {
  PORT_SCAN_COMMAND_TIMEOUT_MS,
  PortScanCommandTimeoutError,
  WATCHDOG_GRACE_MS,
  portScanCommandTimeoutMessage,
  type DarwinPortScanOperation
} from './port-scan-command-protocol'

// Worker-only: EDR hooks can block inline uv_spawn; main-thread imports would reintroduce UI freezes (#11161).

const WATCHDOG_TIMEOUT_MS = PORT_SCAN_COMMAND_TIMEOUT_MS + WATCHDOG_GRACE_MS

const activeChildren = new Set<ChildProcess>()
let stopping = false

/** Measure spawn separately; execution beyond its budget throws PortScanCommandTimeoutError. */
export async function runPortScanCommandInProcess(
  command: string,
  args: string[],
  darwinOperation?: DarwinPortScanOperation
): Promise<{ stdout: string; spawnMs: number }> {
  if (stopping) {
    throw new Error('Port scanning is shutting down.')
  }
  if (process.platform === 'darwin' && darwinOperation) {
    const fd = openDarwinPortScanLock(darwinOperation)
    if (fd !== null) {
      return runDarwinPortScanCommand(command, args, darwinOperation, fd)
    }
  }
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
        (error, stdout, stderr) => {
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
          if (process.platform === 'darwin' && darwinOperation === 'listeners' && stderr) {
            settle(() => reject(new Error('Port scan observation is unavailable.')))
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

function detachChild(child: ChildProcess): void {
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.unref()
}

function isCompletedCwdLsof(command: string, args: string[], stdout: string): boolean {
  const pidList = args[5]
  if (command !== '/usr/sbin/lsof' || !pidList || !/^[1-9]\d*(?:,[1-9]\d*)*$/.test(pidList)) {
    return false
  }
  const expected = ['-O', ...LSOF_NONBLOCKING_ARGS, '-a', '-p', pidList, '-d', 'cwd', '-Fn']
  if (args.length !== expected.length || !expected.every((arg, index) => arg === args[index])) {
    return false
  }
  if (!/^(?:p[1-9]\d*\nfcwd\nn\/[^\n]*\n)*$/.test(stdout)) {
    return false
  }
  const requested = new Set(pidList.split(','))
  return Array.from(stdout.matchAll(/^p(\d+)$/gm)).every((match) => requested.has(match[1]))
}

async function runDarwinPortScanCommand(
  command: string,
  args: string[],
  operation: DarwinPortScanOperation,
  fd: number
): Promise<{ stdout: string; spawnMs: number }> {
  let child: ChildProcess
  const startedAt = Date.now()
  try {
    child = spawnProcess({ program: command, args, stdio: [fd, 'pipe', 'pipe'] })
  } finally {
    closeSync(fd)
  }
  const spawnMs = Date.now() - startedAt
  activeChildren.add(child)
  child.once('exit', () => activeChildren.delete(child))
  return new Promise((resolve, reject) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const listeners = operation === 'listeners' ? new DarwinNetstatListeners() : null
    const settle = (error?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (error) {
        try {
          child.kill()
        } catch {
          /* Best effort; the child still owns admission. */
        }
        detachChild(child)
        reject(error)
      } else {
        resolve({ stdout, spawnMs })
      }
    }
    const timer = setTimeout(
      () =>
        settle(
          new PortScanCommandTimeoutError(
            portScanCommandTimeoutMessage(command, PORT_SCAN_COMMAND_TIMEOUT_MS)
          )
        ),
      PORT_SCAN_COMMAND_TIMEOUT_MS
    )
    child.once('error', (error) => {
      if (!child.pid) {
        activeChildren.delete(child)
      }
      settle(error)
    })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (settled) {
        return
      }
      try {
        if (listeners) {
          listeners.write(chunk)
        } else if (stdout.length + chunk.length <= 2 * 1024 * 1024) {
          stdout += chunk
        } else {
          throw new Error('Port scan output is too large.')
        }
      } catch (error) {
        settle(error)
      }
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(0, 4096)
    })
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('error', (error) => settle(error))
    }
    child.once('close', (code, signal) => {
      if (settled) {
        return
      }
      try {
        const emptyLsof = command === '/usr/sbin/lsof' && code === 1 && stdout === ''
        // A vanished selected PID makes lsof exit 1 after printing the surviving cwd records.
        const completedCwd = code === 1 && isCompletedCwdLsof(command, args, stdout)
        if (
          signal ||
          (stderr && command !== '/usr/sbin/lsof') ||
          (code !== 0 && !emptyLsof && !completedCwd)
        ) {
          throw new Error('Port scan observation is unavailable.')
        }
        if (
          (command === '/usr/sbin/lsof' || command === '/bin/ps') &&
          stdout &&
          !stdout.endsWith('\n')
        ) {
          throw new Error('Incomplete port scan observation.')
        }
        if (listeners) {
          stdout = listeners.finish()
        }
        settle()
      } catch (error) {
        settle(error)
      }
    })
  })
}

/** Signal owned children and detach without waiting for an uninterruptible acquisition. */
export function killActivePortScanCommands(): void {
  stopping = true
  for (const child of activeChildren) {
    try {
      child.kill()
    } catch {
      // Already exited; nothing to reap.
    }
    if (process.platform === 'darwin') {
      detachChild(child)
    }
  }
  if (process.platform !== 'darwin') {
    activeChildren.clear()
  }
}
