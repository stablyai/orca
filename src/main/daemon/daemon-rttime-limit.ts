/**
 * Every terminal inherits the daemon's RLIMIT_RTTIME. A hard limit of 0 makes the kernel SIGKILL
 * any thread whose CPU timer it checks, so terminal jobs die with exit 137 and no trace (#29745).
 * PipeWire's client library sets it when RealtimeKit is missing; unprivileged code can't raise it.
 */
import { readFileSync } from 'node:fs'

export type RealtimeTimeoutLimit = { soft: string; hard: string }

export type RealtimeTimeoutCheckOptions = {
  platform?: NodeJS.Platform
  limitsPath?: string
}

export function realtimeTimeoutLimitFromProcLimits(contents: string): RealtimeTimeoutLimit | null {
  const match = /^Max realtime timeout\s+(\S+)\s+(\S+)/m.exec(contents)
  return match ? { soft: match[1], hard: match[2] } : null
}

/** Fails open: an unreadable or unparseable limits file never warns. */
export function warnWhenRealtimeTimeoutIsZero(
  log: (event: string, details?: Record<string, unknown>) => void,
  options: RealtimeTimeoutCheckOptions = {}
): boolean {
  if ((options.platform ?? process.platform) !== 'linux') {
    return false
  }
  let limit: RealtimeTimeoutLimit | null
  try {
    limit = realtimeTimeoutLimitFromProcLimits(
      readFileSync(options.limitsPath ?? '/proc/self/limits', 'utf8')
    )
  } catch {
    return false
  }
  if (limit?.hard !== '0') {
    return false
  }
  log('rttime-limit-zero', {
    ...limit,
    hint:
      'Terminals inherit a zero RLIMIT_RTTIME, so the kernel may SIGKILL their jobs (exit 137). ' +
      'Install and start RealtimeKit (rtkit), then fully quit Orca so the terminal daemon restarts.'
  })
  return true
}
