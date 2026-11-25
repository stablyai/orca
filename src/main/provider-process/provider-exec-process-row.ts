import { runProcess } from '@orca/process-host'
import {
  beforeDeadline,
  DEADLINE_PASSED,
  monotonicNow
} from '../../shared/concurrency/deadline-settle-notifier'
import { resolveProviderExecPath } from './provider-process-supervisor'
import type { ProcessRowRead } from './provider-process-row-read'

/** The tiny helper can read exact Darwin births even when the addon's worker pool cannot. */
export async function readProviderExecProcessRow(
  pid: number,
  deadline: number
): Promise<ProcessRowRead> {
  const timeoutMs = Math.floor(deadline - monotonicNow())
  if (timeoutMs <= 0) {
    return 'unverifiable'
  }
  try {
    const result = await beforeDeadline(
      runProcess({
        program: resolveProviderExecPath('darwin'),
        args: ['--process-row', String(pid)],
        timeoutMs,
        maxOutputBytes: 128
      }),
      deadline
    )
    if (
      result === DEADLINE_PASSED ||
      result.code !== 0 ||
      result.signal !== null ||
      result.timedOut ||
      result.outputTruncated
    ) {
      return 'unverifiable'
    }
    if (result.stdout === 'absent\n') {
      return null
    }
    const frame = /^(\d+) (\d+) (\d+) (\d+) (\d{1,6})\n$/.exec(result.stdout)
    if (!frame) {
      return 'unverifiable'
    }
    const [observedPid, ppid, pgid, seconds, usec] = frame.slice(1).map(Number)
    if (
      observedPid !== pid ||
      ![observedPid, ppid, pgid, seconds, usec].every(Number.isSafeInteger) ||
      pgid < 1 ||
      usec > 999_999
    ) {
      return 'unverifiable'
    }
    return {
      pid,
      ppid,
      pgid,
      startedAt: `microsecond:${seconds}:${usec}`,
      startResolution: 'microsecond'
    }
  } catch {
    return 'unverifiable'
  }
}
