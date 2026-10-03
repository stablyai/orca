import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting'
import { installRendererUnresponsiveBreadcrumb } from './renderer-unresponsive-breadcrumb'

const recordDurableCrashBreadcrumb = vi.fn()
vi.mock('./durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: (...args: unknown[]) => recordDurableCrashBreadcrumb(...args)
}))
const { getAppMetricsMock } = vi.hoisted(() => ({ getAppMetricsMock: vi.fn(() => [] as unknown[]) }))
vi.mock('electron', () => ({ app: { getAppMetrics: getAppMetricsMock } }))

class FakeWebContents extends EventEmitter {
  destroyed = false
  crashed = false
  osProcessId = 4242
  isDestroyed(): boolean {
    return this.destroyed
  }
  isCrashed(): boolean {
    return this.crashed
  }
  getOSProcessId(): number {
    return this.osProcessId
  }
}

class FakeWindow extends EventEmitter {
  webContents = new FakeWebContents()
  destroyed = false
  isDestroyed(): boolean {
    return this.destroyed
  }
}

type Sample = { workingSet: number; priv: number }

function metricsProvider(samples: Sample[]): () => CrashReportBreadcrumbData {
  let i = 0
  return () => {
    const s = samples[Math.min(i, samples.length - 1)]
    i += 1
    return {
      processMetricsRendererWorkingSetMB: s.workingSet,
      processMetricsRendererPrivateMB: s.priv
    }
  }
}

describe('renderer unresponsive breadcrumb', () => {
  let clock = 0
  const now = (): number => clock

  beforeEach(() => {
    clock = 0
    recordDurableCrashBreadcrumb.mockClear()
    getAppMetricsMock.mockReset()
    getAppMetricsMock.mockReturnValue([])
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function crumbsNamed(name: string): CrashReportBreadcrumbData[] {
    return recordDurableCrashBreadcrumb.mock.calls
      .filter((c) => c[0] === name)
      .map((c) => c[1] as CrashReportBreadcrumbData)
  }

  it('records the freeze onset and samples the renderer climb from the main process', () => {
    const window = new FakeWindow()
    const collectMetricsDetails = metricsProvider([
      { workingSet: 210, priv: 220 },
      { workingSet: 1400, priv: 1450 },
      { workingSet: 3000, priv: 3100 }
    ])
    installRendererUnresponsiveBreadcrumb({
      window: window as never,
      sampleIntervalMs: 30_000,
      now,
      collectMetricsDetails
    })

    window.emit('unresponsive')
    const onset = crumbsNamed('renderer_unresponsive')
    expect(onset).toHaveLength(1)
    expect(onset[0].rendererUnresponsiveElapsedMs).toBe(0)
    expect(onset[0].processMetricsRendererWorkingSetMB).toBe(210)

    clock = 30_000
    vi.advanceTimersByTime(30_000)
    clock = 60_000
    vi.advanceTimersByTime(30_000)

    const samples = crumbsNamed('renderer_unresponsive_sample')
    expect(samples).toHaveLength(2)
    expect(samples[0].rendererUnresponsiveElapsedMs).toBe(30_000)
    expect(samples[0].rendererUnresponsiveSampleIndex).toBe(1)
    expect(samples[0].processMetricsRendererWorkingSetMB).toBe(1400)
    expect(samples[1].processMetricsRendererWorkingSetMB).toBe(3000)
  })

  it('reports duration and peak on recovery, then stops sampling', () => {
    const window = new FakeWindow()
    const collectMetricsDetails = metricsProvider([
      { workingSet: 210, priv: 220 },
      { workingSet: 1400, priv: 1450 }
    ])
    installRendererUnresponsiveBreadcrumb({
      window: window as never,
      sampleIntervalMs: 30_000,
      now,
      collectMetricsDetails
    })

    window.emit('unresponsive')
    clock = 30_000
    vi.advanceTimersByTime(30_000)
    clock = 45_000
    window.emit('responsive')

    const recovered = crumbsNamed('renderer_responsive')
    expect(recovered).toHaveLength(1)
    expect(recovered[0].rendererUnresponsiveDurationMs).toBe(45_000)
    expect(recovered[0].rendererUnresponsiveSampleCount).toBe(1)
    expect(recovered[0].rendererUnresponsivePeakWorkingSetMB).toBe(1400)
    expect(recovered[0].rendererUnresponsivePeakPrivateMB).toBe(1450)

    // No further samples after recovery.
    clock = 75_000
    vi.advanceTimersByTime(60_000)
    expect(crumbsNamed('renderer_unresponsive_sample')).toHaveLength(1)
  })

  it('stops sampling when the renderer dies instead of recovering', () => {
    const window = new FakeWindow()
    installRendererUnresponsiveBreadcrumb({
      window: window as never,
      sampleIntervalMs: 30_000,
      now,
      collectMetricsDetails: metricsProvider([{ workingSet: 100, priv: 100 }])
    })
    window.emit('unresponsive')
    // The frozen renderer dies rather than recovering; the interval sees the
    // crashed process and stops sampling (render-process-gone owns that record).
    window.webContents.crashed = true
    clock = 60_000
    vi.advanceTimersByTime(60_000)
    expect(crumbsNamed('renderer_unresponsive_sample')).toHaveLength(0)
    expect(crumbsNamed('renderer_responsive')).toHaveLength(0)
  })

  it('re-arms onset detection when the poll observes a persistent crashed state', () => {
    const window = new FakeWindow()
    installRendererUnresponsiveBreadcrumb({
      window: window as never,
      sampleIntervalMs: 30_000,
      now,
      collectMetricsDetails: metricsProvider([{ workingSet: 100, priv: 100 }])
    })
    // First freeze ends in a renderer death the poll actually catches.
    window.emit('unresponsive')
    window.webContents.crashed = true
    clock = 60_000
    vi.advanceTimersByTime(60_000)
    expect(crumbsNamed('renderer_unresponsive')).toHaveLength(1)

    // Focus lifecycle reloads the same window; the fresh renderer freezes again.
    window.webContents.crashed = false
    clock = 120_000
    window.emit('unresponsive')
    expect(crumbsNamed('renderer_unresponsive')).toHaveLength(2)
  })

  it('re-arms on the next freeze after a prompt in-place reload the poll never sees', () => {
    const window = new FakeWindow()
    window.webContents.osProcessId = 4242
    installRendererUnresponsiveBreadcrumb({
      window: window as never,
      sampleIntervalMs: 30_000,
      now,
      collectMetricsDetails: metricsProvider([{ workingSet: 100, priv: 100 }])
    })
    // First freeze onset captures pid 4242.
    window.emit('unresponsive')
    expect(crumbsNamed('renderer_unresponsive')).toHaveLength(1)

    // The renderer OOM-dies and reloads in place within ~1s — far faster than the
    // 30s poll — so no tick ever observes crashed===true. The reused webContents
    // now reports a new pid. Without the pid check this second onset (with the old
    // hangStartMs still set) would be dropped as a duplicate: the silent-gap wedge.
    window.webContents.osProcessId = 5555
    clock = 120_000
    window.emit('unresponsive')
    expect(crumbsNamed('renderer_unresponsive')).toHaveLength(2)
  })

  it('resets sampling when the poll sees the tracked renderer replaced by a new pid', () => {
    const window = new FakeWindow()
    window.webContents.osProcessId = 4242
    installRendererUnresponsiveBreadcrumb({
      window: window as never,
      sampleIntervalMs: 30_000,
      now
    })
    getAppMetricsMock.mockReturnValue([
      { pid: 4242, type: 'renderer', memory: { workingSetSize: 500 * 1024 } }
    ])
    window.emit('unresponsive')
    // Renderer reloaded in place under a new pid before the first tick fires; the
    // tick must reset rather than record a sample misattributed to the old freeze.
    window.webContents.osProcessId = 5555
    clock = 30_000
    vi.advanceTimersByTime(30_000)
    expect(crumbsNamed('renderer_unresponsive_sample')).toHaveLength(0)
  })

  it('ignores a duplicate unresponsive for the same renderer pid', () => {
    const window = new FakeWindow()
    window.webContents.osProcessId = 4242
    installRendererUnresponsiveBreadcrumb({
      window: window as never,
      now,
      collectMetricsDetails: metricsProvider([{ workingSet: 100, priv: 100 }])
    })
    window.emit('unresponsive')
    window.emit('unresponsive')
    expect(crumbsNamed('renderer_unresponsive')).toHaveLength(1)
  })

  it('re-arms when the pid is reused but the renderer generation (creationTime) differs', () => {
    const window = new FakeWindow()
    window.webContents.osProcessId = 4242
    // Onset: pid 4242 created at t=1000.
    getAppMetricsMock.mockReturnValue([
      { pid: 4242, type: 'renderer', creationTime: 1000, memory: { workingSetSize: 100 * 1024 } }
    ])
    installRendererUnresponsiveBreadcrumb({ window: window as never, sampleIntervalMs: 30_000, now })
    window.emit('unresponsive')
    expect(crumbsNamed('renderer_unresponsive')).toHaveLength(1)

    // The renderer OOM-dies and reloads in place before any poll tick — Windows
    // reassigns the SAME pid 4242 to the fresh process, but it is a new generation
    // (creationTime 2000). Bare-pid identity would drop this as a duplicate (the
    // silent-gap wedge); (pid, creationTime) sees a different renderer and re-arms.
    getAppMetricsMock.mockReturnValue([
      { pid: 4242, type: 'renderer', creationTime: 2000, memory: { workingSetSize: 100 * 1024 } }
    ])
    clock = 120_000
    window.emit('unresponsive')
    expect(crumbsNamed('renderer_unresponsive')).toHaveLength(2)
  })

  it('re-arms when the onset identity was unresolved and a later freeze resolves one', () => {
    const window = new FakeWindow()
    window.webContents.osProcessId = 0 // getOSProcessId() returns 0 → onset identity unresolved
    installRendererUnresponsiveBreadcrumb({ window: window as never, now })
    window.emit('unresponsive')
    expect(crumbsNamed('renderer_unresponsive')).toHaveLength(1)

    // A reloaded renderer now resolves a pid; the stale unresolved onset must not
    // swallow its fresh freeze as a duplicate.
    window.webContents.osProcessId = 5555
    clock = 120_000
    window.emit('unresponsive')
    expect(crumbsNamed('renderer_unresponsive')).toHaveLength(2)
  })

  it('records only the frozen renderer, not the sum across all renderers', () => {
    const window = new FakeWindow()
    window.webContents.osProcessId = 4242
    getAppMetricsMock.mockReturnValue([
      { pid: 4242, type: 'renderer', memory: { workingSetSize: 500 * 1024, privateBytes: 480 * 1024 } },
      { pid: 9999, type: 'renderer', memory: { workingSetSize: 1200 * 1024, privateBytes: 1150 * 1024 } }
    ])
    // Default collector (no collectMetricsDetails) so pid filtering is exercised.
    installRendererUnresponsiveBreadcrumb({ window: window as never, now })
    window.emit('unresponsive')
    const onset = crumbsNamed('renderer_unresponsive')
    expect(onset).toHaveLength(1)
    expect(onset[0].processMetricsRendererCount).toBe(1)
    expect(onset[0].processMetricsRendererWorkingSetMB).toBe(500)
    expect(onset[0].processMetricsFrozenRendererPidResolved).toBeUndefined()
  })

  it('flags a resolved-but-absent pid distinctly from an unresolved one', () => {
    const window = new FakeWindow()
    window.webContents.osProcessId = 4242
    getAppMetricsMock.mockReturnValue([
      { pid: 9999, type: 'renderer', memory: { workingSetSize: 1200 * 1024 } }
    ])
    installRendererUnresponsiveBreadcrumb({ window: window as never, now })
    window.emit('unresponsive')
    const onset = crumbsNamed('renderer_unresponsive')
    // pid resolved (4242) but its row is absent → the process vanished, not a
    // resolution failure.
    expect(onset[0].processMetricsFrozenRendererAbsentFromMetrics).toBe(true)
    expect(onset[0].processMetricsFrozenRendererPidResolved).toBeUndefined()
  })

  it('flags PidResolved:false only when the os pid cannot be resolved', () => {
    const window = new FakeWindow()
    window.webContents.osProcessId = 0 // getOSProcessId() returns 0 → unresolved
    getAppMetricsMock.mockReturnValue([
      { pid: 9999, type: 'renderer', memory: { workingSetSize: 1200 * 1024 } }
    ])
    installRendererUnresponsiveBreadcrumb({ window: window as never, now })
    window.emit('unresponsive')
    const onset = crumbsNamed('renderer_unresponsive')
    expect(onset[0].processMetricsFrozenRendererPidResolved).toBe(false)
    expect(onset[0].processMetricsFrozenRendererAbsentFromMetrics).toBeUndefined()
  })

  it('detaches listeners on dispose', () => {
    const window = new FakeWindow()
    const { dispose } = installRendererUnresponsiveBreadcrumb({
      window: window as never,
      now,
      collectMetricsDetails: metricsProvider([{ workingSet: 100, priv: 100 }])
    })
    dispose()
    window.emit('unresponsive')
    expect(crumbsNamed('renderer_unresponsive')).toHaveLength(0)
  })

  it('does not throw from dispose when webContents is already destroyed', () => {
    const window = new FakeWindow()
    const { dispose } = installRendererUnresponsiveBreadcrumb({
      window: window as never,
      now,
      collectMetricsDetails: metricsProvider([{ workingSet: 100, priv: 100 }])
    })
    // Electron can destroy webContents before the window 'closed' cleanup runs;
    // reading window.webContents then throws, so we captured it at install.
    window.webContents.destroyed = true
    Object.defineProperty(window, 'webContents', {
      get() {
        throw new Error('Object has been destroyed')
      }
    })
    expect(() => dispose()).not.toThrow()
  })

  it('caps per-hang samples so the breadcrumb ring is not flooded', () => {
    const window = new FakeWindow()
    installRendererUnresponsiveBreadcrumb({
      window: window as never,
      sampleIntervalMs: 30_000,
      now,
      collectMetricsDetails: metricsProvider([{ workingSet: 100, priv: 100 }])
    })
    window.emit('unresponsive')
    // Advance well past the cap (20 samples).
    for (let i = 1; i <= 40; i++) {
      clock = i * 30_000
      vi.advanceTimersByTime(30_000)
    }
    expect(crumbsNamed('renderer_unresponsive_sample')).toHaveLength(20)
  })

  it('records a metrics error instead of throwing when getAppMetrics fails', () => {
    const window = new FakeWindow()
    getAppMetricsMock.mockImplementation(() => {
      throw new Error('metrics unavailable')
    })
    // Use the default (guarded) collector by not passing collectMetricsDetails.
    installRendererUnresponsiveBreadcrumb({ window: window as never, now })
    expect(() => window.emit('unresponsive')).not.toThrow()
    const onset = crumbsNamed('renderer_unresponsive')
    expect(onset).toHaveLength(1)
    expect(onset[0].processMetricsError).toBe('Error')
  })
})
