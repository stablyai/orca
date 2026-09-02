import { runProcessSync } from '../shared/child-process/run-process'
import { getProcessStartedAtMs } from './daemon/daemon-process-start-time'
import { join } from 'node:path'

const PROCESS_LIST_TIMEOUT_MS = 2_000
const PROCESS_LIST_MAX_BYTES = 16 * 1024 * 1024

export type MacUpdateProcessIdentityState = 'alive' | 'dead' | 'unverifiable'

export function isMacUpdateProcessIdentityAlive(
  pid: number,
  expectedStartedAtMs: number,
  readStartedAtMs: (pid: number) => number | null = getProcessStartedAtMs
): boolean {
  return getMacUpdateProcessIdentityState(pid, expectedStartedAtMs, readStartedAtMs) === 'alive'
}

/**
 * A failed process probe is not proof that the process exited. Keep that distinction so a
 * transient ps/TCC failure cannot make ShipIt race an otherwise live desktop owner.
 */
export function getMacUpdateProcessIdentityState(
  pid: number,
  expectedStartedAtMs: number,
  readStartedAtMs: (pid: number) => number | null = getProcessStartedAtMs
): MacUpdateProcessIdentityState {
  let actualStartedAtMs: number | null
  try {
    actualStartedAtMs = readStartedAtMs(pid)
  } catch {
    actualStartedAtMs = null
  }
  if (actualStartedAtMs !== null) {
    return actualStartedAtMs === expectedStartedAtMs ? 'alive' : 'dead'
  }
  try {
    process.kill(pid, 0)
    return 'unverifiable'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unverifiable'
  }
}

export function isMatchingBundleShipItRunning(
  targetBundlePath: string,
  processCommandList: string
): boolean {
  const shipItPath = join(
    targetBundlePath,
    'Contents',
    'Frameworks',
    'Squirrel.framework',
    'Resources',
    'ShipIt'
  )
  return processCommandList.split('\n').some((line) => {
    const command = line.trimStart()
    return command === shipItPath || command.startsWith(`${shipItPath} `)
  })
}

export type MacUpdateShipItState = 'alive' | 'absent' | 'unknown'

/** null means the probe itself failed — callers must treat that as unknown, not as absence. */
export function readAllProcessCommands(): string | null {
  try {
    const result = runProcessSync({
      program: '/bin/ps',
      args: ['-ww', '-axo', 'command='],
      timeoutMs: PROCESS_LIST_TIMEOUT_MS,
      maxOutputBytes: PROCESS_LIST_MAX_BYTES
    })
    return result.code === 0 ? result.stdout : null
  } catch {
    return null
  }
}
