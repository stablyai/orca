import { readFileSync } from 'node:fs'

// Why: at 0 the kernel kills any thread with a CPU timer armed (SIGXCPU at soft, SIGKILL at hard) and unprivileged code can't raise the hard limit (#29745).
export type ZeroRtTimeLimit = { soft: string; hard: string }

function readProcLimits(platform: NodeJS.Platform, limitsPath: string): string | null {
  if (platform !== 'linux') {
    return null
  }
  try {
    return readFileSync(limitsPath, 'utf8')
  } catch {
    return null
  }
}

/** Raw RLIMIT_RTTIME bounds (us or "unlimited") when either is 0; null otherwise, unreadable, or off Linux. */
export function readZeroRtTimeLimit(
  platform: NodeJS.Platform = process.platform,
  limitsPath = '/proc/self/limits'
): ZeroRtTimeLimit | null {
  const limits = readProcLimits(platform, limitsPath)
  const [, soft, hard] = (limits && /^Max realtime timeout\s+(\S+)\s+(\S+)/m.exec(limits)) || []
  return soft === '0' || hard === '0' ? { soft, hard } : null
}

/** True when RLIMIT_RTPRIO lets this process (or a later setrlimit) make threads SCHED_RR/FIFO. */
export function allowsRealtimePriority(
  platform: NodeJS.Platform = process.platform,
  limitsPath = '/proc/self/limits'
): boolean {
  const limits = readProcLimits(platform, limitsPath)
  const [, soft, hard] = (limits && /^Max realtime priority\s+(\S+)\s+(\S+)/m.exec(limits)) || []
  return (soft !== undefined && soft !== '0') || (hard !== undefined && hard !== '0')
}
