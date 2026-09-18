import { vi } from 'vitest'

// Mirrors the browser rule for WebIDL global operations: an explicit non-global
// receiver is rejected, while an absent one resolves to the global.
function assertGlobalReceiver(receiver: unknown): void {
  if (receiver !== undefined && receiver !== globalThis) {
    throw new TypeError('Illegal invocation')
  }
}

// Wraps whatever timers are currently installed (real or vitest's fakes), so callers
// keep using vi.advanceTimersByTime. Undo with vi.unstubAllGlobals().
export function installIllegalInvocationTimerGuards(): void {
  const scheduleTimer = globalThis.setTimeout
  const cancelTimer = globalThis.clearTimeout
  vi.stubGlobal('setTimeout', function (this: unknown, handler: () => void, ms?: number) {
    assertGlobalReceiver(this)
    return scheduleTimer(handler, ms)
  })
  vi.stubGlobal('clearTimeout', function (this: unknown, handle: ReturnType<typeof setTimeout>) {
    assertGlobalReceiver(this)
    cancelTimer(handle)
  })
}
