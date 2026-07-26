import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearCrashBreadcrumbsForTest,
  getCrashBreadcrumbSnapshot
} from './crash-reporting/crash-breadcrumb-store'
import { registerSystemResumeBroadcast, SYSTEM_RESUMED_CHANNEL } from './system-resume-broadcast'

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
    // Why: match on identity so detaching a different closure than the one
    // registered still leaves a live listener, as it would on real powerMonitor.
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
  it('broadcasts the resume channel to every live window', () => {
    const { source, fireResume } = createResumeSource()
    const liveWindow = createWindow()
    const destroyedWindow = createWindow(true)
    registerSystemResumeBroadcast({
      resumeSource: source,
      getWindows: () => [liveWindow, destroyedWindow]
    })

    fireResume()

    expect(liveWindow.webContents.send).toHaveBeenCalledWith(SYSTEM_RESUMED_CHANNEL)
    expect(destroyedWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('stops broadcasting after unsubscribe', () => {
    const { source, fireResume } = createResumeSource()
    const window = createWindow()
    const unsubscribe = registerSystemResumeBroadcast({
      resumeSource: source,
      getWindows: () => [window]
    })

    unsubscribe()
    fireResume()

    // Why: detaching a different closure than the one registered leaks a real
    // powerMonitor listener, and for 'suspend' that leak is otherwise unobservable.
    expect(source.off.mock.calls).toEqual(source.on.mock.calls)
    expect(window.webContents.send).not.toHaveBeenCalled()
  })

  it('records the sleep span so a heartbeat gap is attributable to suspend', () => {
    const { source, fireSuspend, fireResume } = createResumeSource()
    const clock = { value: 1_000 }
    registerSystemResumeBroadcast({
      resumeSource: source,
      getWindows: () => [],
      now: () => clock.value
    })

    fireSuspend()
    clock.value += 109 * 60_000
    fireResume()

    expect(breadcrumbNames()).toEqual(['system_slept'])
    expect(getCrashBreadcrumbSnapshot().at(-1)?.data).toEqual({ suspendedForMs: 109 * 60_000 })
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
    // Why: dark wake re-suspends without a resume; reporting only the trailing 20s
    // would leave the 90 preceding minutes looking like an unexplained freeze.
    fireSuspend()
    clock.value += 20_000
    fireResume()

    expect(getCrashBreadcrumbSnapshot().at(-1)?.data).toEqual({
      suspendedForMs: 90 * 60_000 + 20_000
    })
  })

  it('records nothing when resume arrives without a recorded suspend', () => {
    const { source, fireResume } = createResumeSource()
    const window = createWindow()
    registerSystemResumeBroadcast({ resumeSource: source, getWindows: () => [window] })

    fireResume()

    expect(breadcrumbNames()).toEqual([])
    expect(window.webContents.send).toHaveBeenCalledWith(SYSTEM_RESUMED_CHANNEL)
  })

  it('ignores sleeps too short to open a gap, keeping ring slots for real evidence', () => {
    const { source, fireSuspend, fireResume } = createResumeSource()
    const clock = { value: 0 }
    registerSystemResumeBroadcast({
      resumeSource: source,
      getWindows: () => [],
      now: () => clock.value
    })

    // Why: 20 sub-heartbeat cycles must not evict the 30-entry breadcrumb ring.
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
    // Why: a spurious resume after the cycles must not re-report the last sleep.
    clock.value += 30 * 60_000
    fireResume()

    const spans = getCrashBreadcrumbSnapshot().map((breadcrumb) => breadcrumb.data?.suspendedForMs)
    expect(spans).toEqual([5 * 60_000, 2 * 60_000])
  })
})
