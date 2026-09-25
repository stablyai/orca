import { vi } from 'vitest'

// Mirrors the browser rule for WebIDL global operations: an explicit non-global
// receiver is rejected, while an absent one resolves to the global.
function assertGlobalReceiver(receiver: unknown): void {
  if (receiver !== undefined && receiver !== globalThis) {
    throw new TypeError('Illegal invocation')
  }
}

export type GuardedTimerHandles = {
  scheduled: ReturnType<typeof setTimeout>[]
  cleared: ReturnType<typeof setTimeout>[]
}

// Wraps whatever timers are currently installed (real or vitest's fakes), so callers
// keep using vi.advanceTimersByTime. Undo with vi.unstubAllGlobals().
export function installIllegalInvocationTimerGuards(): GuardedTimerHandles {
  const scheduleTimer = globalThis.setTimeout
  const cancelTimer = globalThis.clearTimeout
  const handles: GuardedTimerHandles = { scheduled: [], cleared: [] }
  vi.stubGlobal('setTimeout', function (this: unknown, handler: () => void, ms?: number) {
    assertGlobalReceiver(this)
    const handle = scheduleTimer(handler, ms)
    handles.scheduled.push(handle)
    return handle
  })
  vi.stubGlobal('clearTimeout', function (this: unknown, handle: ReturnType<typeof setTimeout>) {
    assertGlobalReceiver(this)
    handles.cleared.push(handle)
    cancelTimer(handle)
  })
  return handles
}
