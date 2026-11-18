import { app, powerMonitor, type WebContents } from 'electron'
import { join } from 'node:path'
import { resolveObservabilityConsent } from '../observability'
import { createLocalFileSink } from '../observability/local-file-sink'

type Target = { contents: WebContents; generation: number; dispose: () => void }
type Baseline = { cpu: number; observedAt: number; hotSamples: number }

class CompositorDiagnostics {
  private readonly targets = new Map<number, Target>()
  private readonly baselines = new Map<string, Baseline>()
  private readonly sink: ReturnType<typeof createLocalFileSink>
  private timer: ReturnType<typeof setTimeout> | null = null
  private due = 0
  private delay = 30_000
  private tick = 0
  private stopped = false
  private disabledReason: string | null = null

  constructor() {
    this.sink = createLocalFileSink({
      filePath: join(app.getPath('userData'), 'compositor-diagnostics', 'observations.ndjson'),
      maxBytes: 256 * 1024,
      maxFiles: 2,
      maxQueuedChars: 64 * 1024
    })
    app.on('will-quit', this.stop)
    powerMonitor.on('suspend', this.reset)
    powerMonitor.on('resume', this.reset)
    this.write({
      kind: 'started',
      electron: process.versions.electron?.split('.').map(Number),
      chrome: process.versions.chrome?.split('.').map(Number)
    })
  }

  register(contents: WebContents): void {
    if (this.targets.has(contents.id) || contents.isDestroyed() || this.stopped) {
      return
    }
    if (this.targets.size >= 64) {
      this.write({ kind: 'unavailable', reason: 'target-budget' })
      return
    }
    const invalidate = (): void => {
      target.generation++
      this.reset()
    }
    const navigation = (
      _event: Electron.Event,
      _url: string,
      inPlace: boolean,
      mainFrame: boolean
    ): void => {
      if (mainFrame && !inPlace) {
        invalidate()
      }
    }
    const retire = (): void => {
      target.dispose()
      this.targets.delete(contents.id)
      this.reset()
      if (this.targets.size === 0) {
        this.pause()
        this.write({ kind: 'waiting-for-window' }, 'waiting-for-window')
      }
    }
    const target: Target = {
      contents,
      generation: 0,
      dispose: () => {
        contents.off('did-start-navigation', navigation)
        contents.off('render-process-gone', invalidate)
        contents.off('destroyed', retire)
      }
    }
    contents.on('did-start-navigation', navigation)
    contents.on('render-process-gone', invalidate)
    contents.on('destroyed', retire)
    this.targets.set(contents.id, target)
    if (!this.timer) {
      this.delay = 30_000
      this.schedule()
    }
  }

  private readonly reset = (): void => {
    this.baselines.clear()
  }

  private pause(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(): void {
    this.pause()
    this.due = performance.now() + this.delay
    this.timer = setTimeout(() => {
      this.timer = null
      this.sample()
      if (!this.stopped && this.targets.size > 0) {
        this.schedule()
      }
    }, this.delay)
    this.timer.unref()
  }

  private write(value: Record<string, unknown>, state?: string): void {
    if (!this.stopped && resolveObservabilityConsent().localFileEnabled) {
      this.sink.push({
        version: 1,
        time: Date.now(),
        state: state ?? (this.disabledReason ? 'disabled-for-session' : 'observing-cpu-only'),
        lastResult: value,
        coverageLimits: {
          processes: 32,
          targets: 64,
          captureMillisPerHour: 0,
          captureBytesPerHour: 0
        },
        disabledForSessionReason: this.disabledReason
      })
    }
  }

  private sample(): void {
    if (this.stopped || !resolveObservabilityConsent().localFileEnabled) {
      this.stop()
      return
    }
    const now = performance.now()
    if (now - this.due > 15_000) {
      this.reset()
      return
    }
    const started = performance.now()
    let metrics: Electron.ProcessMetric[]
    try {
      metrics = app.getAppMetrics()
    } catch {
      this.disabledReason = 'metrics-unavailable'
      this.write({ kind: 'unavailable', reason: 'metrics-unavailable' })
      this.stop()
      return
    }
    if (performance.now() - started > 5) {
      this.disabledReason = 'metrics-budget'
      this.write({ kind: 'unavailable', reason: 'metrics-budget' })
      this.stop()
      return
    }
    const byPid = new Map(metrics.map((metric) => [metric.pid, metric]))
    const groups = new Map<string, { pid: number; cpu: number; targets: Target[] }>()
    for (const target of this.targets.values()) {
      try {
        const pid = target.contents.getOSProcessId()
        const metric = byPid.get(pid)
        const cpu = metric?.cpu.cumulativeCPUUsage
        if (
          !metric ||
          !Number.isFinite(metric.creationTime) ||
          metric.creationTime <= 0 ||
          typeof cpu !== 'number' ||
          !Number.isFinite(cpu) ||
          cpu < 0
        ) {
          continue
        }
        const key = `${pid}:${metric.creationTime}`
        const group = groups.get(key) ?? { pid, cpu, targets: [] }
        group.targets.push(target)
        groups.set(key, group)
      } catch {
        // A target may die between the process snapshot and identity read.
      }
    }
    const candidates = [...groups.entries()]
    const offset = candidates.length > 32 ? (Math.floor(this.tick / 4) * 32) % candidates.length : 0
    const admitted = [...candidates.slice(offset), ...candidates.slice(0, offset)].slice(0, 32)
    this.tick++
    const keys = new Set(admitted.map(([key]) => key))
    for (const key of this.baselines.keys()) {
      if (!keys.has(key)) {
        this.baselines.delete(key)
      }
    }
    let hot = false
    for (const [key, group] of admitted) {
      const prior = this.baselines.get(key)
      const seconds = prior ? (now - prior.observedAt) / 1000 : 0
      const cores =
        prior && seconds > 0 && group.cpu >= prior.cpu ? (group.cpu - prior.cpu) / seconds : null
      const hotSamples = cores !== null && cores >= 0.2 ? (prior?.hotSamples ?? 0) + 1 : 0
      hot ||= hotSamples > 0
      this.baselines.set(key, { cpu: group.cpu, observedAt: now, hotSamples })
      const targets = group.targets.map((target) => ({
        id: target.contents.id,
        generation: target.generation,
        surfaceIdentity: null
      }))
      this.write({
        kind: 'cpu-observation',
        processIdentity: { pid: group.pid, creationTime: byPid.get(group.pid)?.creationTime },
        cores,
        targets,
        classification: 'observations-only',
        missedProcesses: Math.max(0, groups.size - 32)
      })
    }
    // Quiet renderers need no 30-second wakeup; sustained cost restores the shorter cadence.
    this.delay = hot ? 30_000 : Math.min(this.delay * 2, 300_000)
  }

  readonly stop = (): void => {
    if (this.stopped) {
      return
    }
    this.write({ kind: 'stopped' }, this.disabledReason ? 'disabled-for-session' : 'stopped')
    this.stopped = true
    this.pause()
    app.off('will-quit', this.stop)
    powerMonitor.off('suspend', this.reset)
    powerMonitor.off('resume', this.reset)
    for (const target of this.targets.values()) {
      target.dispose()
    }
    this.targets.clear()
    this.baselines.clear()
    void this.sink.closeAsync(500)
  }
}

let monitor: CompositorDiagnostics | null = null

export function registerCompositorDiagnostics(contents: WebContents): void {
  // Operator-only experiments; no packaged rollout, UI setting, telemetry or recovery action.
  if (
    app.isPackaged ||
    process.env.ORCA_COMPOSITOR_DIAGNOSTICS !== '1' ||
    !resolveObservabilityConsent().localFileEnabled
  ) {
    return
  }
  try {
    monitor ??= new CompositorDiagnostics()
    monitor.register(contents)
  } catch {
    monitor?.stop()
  }
}
