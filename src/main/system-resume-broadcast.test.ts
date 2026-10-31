import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot
} from './crash-reporting/crash-breadcrumb-store'
import { registerSystemResumeBroadcast } from './system-resume-broadcast'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  powerMonitor: { on: vi.fn(), off: vi.fn() }
}))

beforeEach(clearCrashBreadcrumbsForTest)

type ResumeListener = () => void
type PowerLifecycleEvent = 'suspend' | 'resume'

function createResumeSource() {
  const listeners = new Map<PowerLifecycleEvent, ResumeListener>()
  const source = {
    on: vi.fn((event: PowerLifecycleEvent, callback: ResumeListener) => {
      listeners.set(event, callback)
    }),
    // Match listener identity so removing the wrong closure exposes a leak.
    off: vi.fn((event: PowerLifecycleEvent, callback: ResumeListener) => {
      if (listeners.get(event) === callback) {
        listeners.delete(event)
      }
    })
  }
  return {
    source,
    fireSuspend: () => listeners.get('suspend')?.(),
    fireResume: () => listeners.get('resume')?.()
  }
}

function breadcrumbNames(): string[] {
  return getCrashBreadcrumbSnapshot().map((breadcrumb) => breadcrumb.name)
}

function createWindow(destroyed = false): {
  isDestroyed: () => boolean
  webContents: { send: ReturnType<typeof vi.fn<(channel: string) => void>> }
} {
  return {
    isDestroyed: () => destroyed,
    webContents: { send: vi.fn<(channel: string) => void>() }
  }
}

describe('registerSystemResumeBroadcast', () => {
  it('stops broadcasting after unsubscribe', () => {
    const { source, fireResume } = createResumeSource()
    const window = createWindow()
    const unsubscribe = registerSystemResumeBroadcast({
      resumeSource: source,
      getWindows: () => [window]
    })

    unsubscribe()
    fireResume()

    expect(source.off.mock.calls).toEqual(source.on.mock.calls)
    expect(window.webContents.send).not.toHaveBeenCalled()
  })

  it('spans from the first suspend when dark wake swallows the intervening resume', () => {
    const { source, fireSuspend, fireResume } = createResumeSource()
    const clock = { value: 0 }
    registerSystemResumeBroadcast({
      resumeSource: source,
      getWindows: () => [],
      now: () => clock.value
    })

    fireSuspend()
    clock.value += 90 * 60_000
    // Dark wake can re-suspend without reporting the preceding sleep.
    fireSuspend()
    clock.value += 20_000
    fireResume()

    expect(getCrashBreadcrumbSnapshot().at(-1)?.data).toEqual({
      suspendedForMs: 90 * 60_000 + 20_000
    })
  })

  it('ignores sleeps too short to open a gap, keeping ring slots for real evidence', () => {
    const { source, fireSuspend, fireResume } = createResumeSource()
    const clock = { value: 0 }
    registerSystemResumeBroadcast({
      resumeSource: source,
      getWindows: () => [],
      now: () => clock.value
    })

    // Sub-heartbeat cycles must not evict the 30-entry breadcrumb ring.
    for (let cycle = 0; cycle < 20; cycle++) {
      fireSuspend()
      clock.value += 2_000
      fireResume()
      clock.value += 30_000
    }

    expect(breadcrumbNames()).toEqual([])
  })

  it('measures each reportable sleep independently across repeated cycles', () => {
    const { source, fireSuspend, fireResume } = createResumeSource()
    const clock = { value: 0 }
    registerSystemResumeBroadcast({
      resumeSource: source,
      getWindows: () => [],
      now: () => clock.value
    })

    fireSuspend()
    clock.value += 5 * 60_000
    fireResume()
    clock.value += 60_000
    fireSuspend()
    clock.value += 2 * 60_000
    fireResume()
    clock.value += 30 * 60_000
    fireResume()

    const spans = getCrashBreadcrumbSnapshot().map((breadcrumb) => breadcrumb.data?.suspendedForMs)
    expect(spans).toEqual([5 * 60_000, 2 * 60_000])
  })
})
