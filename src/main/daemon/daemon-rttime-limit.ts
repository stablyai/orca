import { readFileSync } from 'node:fs'

// Why: PTYs inherit the daemon's RLIMIT_RTTIME; at 0 the kernel kills timer-armed jobs (SIGXCPU soft, SIGKILL hard) and unprivileged code can't raise the hard limit (#29745).
export function warnWhenRealtimeTimeoutIsZero(
  log: (event: string, details?: Record<string, unknown>) => void,
  platform: NodeJS.Platform = process.platform,
  limitsPath = '/proc/self/limits'
): void {
  if (platform !== 'linux') {
    return
  }
  let limits: string
  try {
    limits = readFileSync(limitsPath, 'utf8')
  } catch {
    return
  }
  const [, soft, hard] = /^Max realtime timeout\s+(\S+)\s+(\S+)/m.exec(limits) ?? []
  if (soft !== '0' && hard !== '0') {
    return
  }
  log('rttime-limit-zero', {
    soft,
    hard,
    hint:
      'Terminals inherit a zero RLIMIT_RTTIME, so the kernel may kill their jobs (exit 137 or 152). ' +
      'Installing and enabling RealtimeKit (rtkit), then rebooting, often restores a nonzero limit; ' +
      'if this keeps appearing, check the launcher, desktop session, or systemd unit (LimitRTTIME) that starts Orca.'
  })
}
