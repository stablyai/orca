import type { ForkFallbackValue } from '../../../../shared/daemon-tcc-denial-capture'

export type MacDaemonForkReason = Exclude<ForkFallbackValue, 'none' | 'unknown'>

// Why this app's latest launch forked instead of using launchd; null after a launchd launch.
let lastMacForkReason: MacDaemonForkReason | null = null

export function setLastMacDaemonForkReason(reason: MacDaemonForkReason | null): void {
  lastMacForkReason = reason
}

export function getLastMacDaemonForkReason(): MacDaemonForkReason | null {
  return lastMacForkReason
}
