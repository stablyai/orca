import { CRASH_FUSE_COOLDOWN_INITIAL_MS } from './parcel-watcher-crash-fuse'

// Retry when the crash fuse half-opens so fallback polling does not remain permanent until restart.
export const GIT_COMMON_NATIVE_UPGRADE_INTERVAL_MS = CRASH_FUSE_COOLDOWN_INITIAL_MS

export function createNativeUpgradePoll(attempt: () => Promise<void>): {
  arm: () => void
  stop: () => void
} {
  let timer: ReturnType<typeof setInterval> | null = null
  return {
    arm: () => {
      if (!timer) {
        timer = setInterval(() => void attempt(), GIT_COMMON_NATIVE_UPGRADE_INTERVAL_MS)
        timer.unref?.()
      }
    },
    stop: () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }
}
