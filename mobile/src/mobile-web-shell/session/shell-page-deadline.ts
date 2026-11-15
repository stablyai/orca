import type { MobileWebShellRuntime } from './mobile-web-shell-runtime'

// Keep one live deadline: each one armed belongs to a document that superseded or proved the last; epoch guards alone leave real timers alive until expiry.
export function createShellPageDeadline(
  setForegroundTimer: MobileWebShellRuntime['setForegroundTimer']
): { arm(delayMs: number, expire: () => void): void; cancel(): void } {
  let cancelArmed: (() => void) | null = null
  const cancel = (): void => {
    cancelArmed?.()
    cancelArmed = null
  }
  return {
    arm(delayMs, expire) {
      cancel()
      cancelArmed = setForegroundTimer(() => {
        cancelArmed = null
        expire()
      }, delayMs)
    },
    cancel
  }
}
