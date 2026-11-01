import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'

const SWEEP_TIMEOUT_MS = 5_000
const SWEEP_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const STATUS_DIR_PREFIX = 'orca-computer-use-permissions-'
const STATUS_ARG = '/orca-computer-use-macos --permission-status-file '

// Why: the status directory is deleted when a check ends, so a helper whose directory is gone
// belongs to a finished check of any Orca instance; a live directory is an in-flight check.
export function findStalePermissionStatusHelperPids(
  psOutput: string,
  statusDirExists: (dir: string) => boolean
): number[] {
  const pids: number[] = []
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    const argIndex = match ? match[2].indexOf(STATUS_ARG) : -1
    if (!match || argIndex < 0) {
      continue
    }
    const statusPath = match[2].slice(argIndex + STATUS_ARG.length).trim()
    const dir = dirname(statusPath)
    if (basename(statusPath) !== 'status.json' || !basename(dir).startsWith(STATUS_DIR_PREFIX)) {
      continue
    }
    if (!statusDirExists(dir)) {
      pids.push(Number(match[1]))
    }
  }
  return pids
}

// Why: `open -n` detaches the helper, so a wedged one outlives the timeout that killed `open`
// and each leaked instance keeps a LaunchServices registration.
export async function sweepStalePermissionStatusHelpers(): Promise<number[]> {
  const uid = process.getuid?.()
  if (process.platform !== 'darwin' || uid === undefined) {
    return []
  }
  let stdout: string
  try {
    const result = await runProcess({
      program: '/bin/ps',
      args: ['-ww', '-U', String(uid), '-o', 'pid=', '-o', 'command='],
      timeoutMs: SWEEP_TIMEOUT_MS,
      maxOutputBytes: SWEEP_MAX_OUTPUT_BYTES
    })
    if (result.timedOut) {
      return []
    }
    stdout = result.stdout
  } catch {
    return []
  }
  const killed: number[] = []
  for (const pid of findStalePermissionStatusHelperPids(stdout, existsSync)) {
    try {
      process.kill(pid, 'SIGKILL')
      killed.push(pid)
    } catch {
      // Already exited.
    }
  }
  return killed
}
