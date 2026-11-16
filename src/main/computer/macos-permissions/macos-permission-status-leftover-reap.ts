import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { runProcess } from '@orca/process-host'

// Older builds launched probes through LaunchServices, which could leave one suspended forever.
const LEFTOVER_PROBE =
  /^(?:.*\/)?orca-computer-use-macos --permission-status-file (\/\S+\/orca-computer-use-permissions-[A-Za-z0-9]{6}\/status\.json)$/
// Those probes gave up after 10 s, so an older one is leaked even if its probe directory survived a crash.
const LEFTOVER_PROBE_MIN_AGE_SECONDS = 60

export async function reapLeftoverMacOSPermissionStatusHelpers(): Promise<void> {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') {
    return
  }
  const listing = await runProcess({
    program: '/bin/ps',
    args: ['-ww', '-U', String(process.getuid()), '-o', 'pid=,etime=,command='],
    env: { ...process.env, LC_ALL: 'C' },
    timeoutMs: 5_000,
    maxOutputBytes: 4 * 1024 * 1024,
    killOnOutputLimit: true
  }).catch(() => null)
  if (!listing || listing.timedOut || listing.outputTruncated || listing.code !== 0) {
    return
  }
  for (const line of listing.stdout.split('\n')) {
    const row = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line)
    const statusPath = row ? LEFTOVER_PROBE.exec(row[3])?.[1] : undefined
    if (!row || !statusPath) {
      continue
    }
    // A probe deletes its directory when it finishes, so a young probe with one may still be live in another Orca.
    if (
      elapsedSeconds(row[2]) < LEFTOVER_PROBE_MIN_AGE_SECONDS &&
      (await probeDirectoryMayExist(dirname(statusPath)))
    ) {
      continue
    }
    try {
      // SIGKILL because a suspended process never runs a handler.
      process.kill(Number(row[1]), 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

// ps etime is [[dd-]hh:]mm:ss.
function elapsedSeconds(etime: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime)
  if (!match) {
    return 0
  }
  const [, days = '0', hours = '0', minutes, seconds] = match
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)
}

async function probeDirectoryMayExist(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}
