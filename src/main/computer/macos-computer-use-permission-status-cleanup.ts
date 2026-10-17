import { lstat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { runProcess } from '@orca/process-host'
import { escapeRegex } from '../../shared/string-utils'

export const PERMISSION_STATUS_TEMP_DIR_PREFIX = 'orca-computer-use-permissions-'

const PERMISSION_STATUS_HELPER_COMMAND =
  /^\s*(\d+)\s+\S.*\/orca-computer-use-macos\s+--permission-status-file\s+(\/.+)$/

export async function stopMacOSPermissionStatusHelper(statusPath: string): Promise<void> {
  // The unique status path distinguishes this completed probe from concurrent probes and setup helpers.
  await runProcess({
    program: '/usr/bin/pkill',
    args: [
      '-f',
      `(^|[[:space:]/])orca-computer-use-macos[[:space:]]+--permission-status-file[[:space:]]+${escapeRegex(statusPath)}$`
    ],
    timeoutMs: 2_000,
    stdio: 'ignore'
  }).catch(() => undefined)
}

// Why: when LaunchServices is backlogged, `open` times out before the helper is spawned, so the
// per-probe pkill runs too early and the late helper is left suspended; these pile up across probes.
export async function reapOrphanedMacOSPermissionStatusHelpers(): Promise<void> {
  const uid = process.getuid?.()
  if (uid === undefined) {
    return
  }
  const result = await runProcess({
    program: '/bin/ps',
    args: ['-ww', '-x', '-U', String(uid), '-o', 'pid=,command='],
    env: { ...process.env, LC_ALL: 'C' },
    timeoutMs: 2_000,
    maxOutputBytes: 1024 * 1024,
    killOnOutputLimit: true
  }).catch(() => null)
  if (!result || result.timedOut || result.code !== 0) {
    return
  }
  for (const line of result.stdout.split('\n')) {
    const match = PERMISSION_STATUS_HELPER_COMMAND.exec(line)
    const statusPath = match?.[2]
    if (!match || !statusPath || !isPermissionStatusPath(statusPath)) {
      continue
    }
    // A live probe (from any Orca instance) still owns its temp dir; only its finally removes it.
    if (await pathExists(dirname(statusPath))) {
      continue
    }
    try {
      process.kill(Number(match[1]), 'SIGKILL')
    } catch {
      // Already exited.
    }
  }
}

function isPermissionStatusPath(statusPath: string): boolean {
  return (
    basename(statusPath) === 'status.json' &&
    basename(dirname(statusPath)).startsWith(PERMISSION_STATUS_TEMP_DIR_PREFIX)
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    // Unknown errors count as present so an unreadable dir never gets its helper killed.
    return !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
  }
}
