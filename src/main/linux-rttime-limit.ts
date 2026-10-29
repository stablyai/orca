import { readFileSync } from 'node:fs'

// Why: at 0 the kernel kills any thread with a CPU timer armed (SIGXCPU at soft, SIGKILL at hard) and unprivileged code can't raise the hard limit (#29745).
export type ZeroRtTimeLimit = { soft: string; hard: string }

/** Raw RLIMIT_RTTIME bounds (us or "unlimited") when either is 0; null otherwise, unreadable, or off Linux. */
export function readZeroRtTimeLimit(
  platform: NodeJS.Platform = process.platform,
  limitsPath = '/proc/self/limits'
): ZeroRtTimeLimit | null {
  if (platform !== 'linux') {
    return null
  }
  let limits: string
  try {
    limits = readFileSync(limitsPath, 'utf8')
  } catch {
    return null
  }
  const [, soft, hard] = /^Max realtime timeout\s+(\S+)\s+(\S+)/m.exec(limits) ?? []
  return soft === '0' || hard === '0' ? { soft, hard } : null
}
