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
    off: vi.fn((event: PowerLifecycleEvent, _callback: ResumeListener) => {
      listeners.delete(event)
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

    expect(source.off).toHaveBeenCalledWith('resume', expect.any(Function))
    expect(source.off).toHaveBeenCalledWith('suspend', expect.any(Function))
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

    expect(breadcrumbNames()).toEqual(['system_suspended', 'system_resumed'])
    expect(getCrashBreadcrumbSnapshot().at(-1)?.data).toEqual({ suspendedForMs: 109 * 60_000 })
  })

  it('omits the sleep span when resume arrives without a recorded suspend', () => {
    const { source, fireResume } = createResumeSource()
    registerSystemResumeBroadcast({ resumeSource: source, getWindows: () => [] })

    fireResume()

    expect(breadcrumbNames()).toEqual(['system_resumed'])
    expect(getCrashBreadcrumbSnapshot().at(-1)?.data).toBeUndefined()
  })

  it('measures each sleep span independently across repeated cycles', () => {
    const { source, fireSuspend, fireResume } = createResumeSource()
    const clock = { value: 0 }
    registerSystemResumeBroadcast({
      resumeSource: source,
      getWindows: () => [],
      now: () => clock.value
    })

    fireSuspend()
    clock.value += 5_000
    fireResume()
    clock.value += 60_000
    fireSuspend()
    clock.value += 2_000
    fireResume()
    // Why: a spurious resume after the cycles must not re-report the last sleep.
    clock.value += 30_000
    fireResume()

    const spans = getCrashBreadcrumbSnapshot()
      .filter((breadcrumb) => breadcrumb.name === 'system_resumed')
      .map((breadcrumb) => breadcrumb.data?.suspendedForMs)
    expect(spans).toEqual([5_000, 2_000, undefined])
  })
})
