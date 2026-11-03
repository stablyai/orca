import { readZeroRtTimeLimit } from '../linux-rttime-limit'

// Why: PTYs inherit the daemon's RLIMIT_RTTIME, so a zero limit can kill terminal jobs.
export function warnWhenRealtimeTimeoutIsZero(
  log: (event: string, details?: Record<string, unknown>) => void,
  platform: NodeJS.Platform = process.platform,
  limitsPath = '/proc/self/limits'
): void {
  const limit = readZeroRtTimeLimit(platform, limitsPath)
  if (!limit) {
    return
  }
  log('rttime-limit-zero', {
    ...limit,
    hint:
      'Terminals inherit a zero RLIMIT_RTTIME, so the kernel may kill their jobs (exit 137 or 152). ' +
      'Installing and enabling RealtimeKit (rtkit), then rebooting, often restores a nonzero limit; ' +
      'if this keeps appearing, check the launcher, desktop session, or systemd unit (LimitRTTIME) that starts Orca.'
  })
}
