import { app, type BrowserWindow } from 'electron'
import { DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS } from '../crash-reporting/gpu-crash-fallback-decision'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'

// Field: D3D11 exit 34, then a zero-working-set GPU and a blocked renderer.
export const RENDERER_GPU_STALL_PING_INTERVAL_MS = 2_000
export const RENDERER_GPU_STALL_TIMEOUT_MS = 8_000
// Why: Chromium aborts the browser after repeated GPU deaths; never loop kills.
export const RENDERER_GPU_STALL_MAX_KILLS = 1
// Above this share of one core the renderer is busy in JS, not blocked on the GPU.
const BUSY_RENDERER_CPU_SHARE = 0.5

type GpuProcessIdentity = { pid: number; creationTime: number }

export type RendererGpuStallWatchdogDeps = {
  /** Resolves once the renderer main thread has run a task. */
  pingRenderer: () => Promise<unknown>
  /** False while loading, crashed, destroyed or paused in DevTools. */
  canPing: () => boolean
  /** Cumulative renderer CPU seconds, or null when unknown. */
  readRendererCpuSeconds: () => number | null
  readGpuProcesses: () => readonly GpuProcessIdentity[]
  readGpuCrashTimes: () => readonly number[]
  killProcess: (pid: number) => void
  onGpuKilled: (info: { stalledMs: number; gpuPids: number[]; kills: number }) => void
  now?: () => number
}

type OutstandingPing = {
  startedAt: number
  deadline: number
  cpuSecondsAtStart: number
  gpu: GpuProcessIdentity
}

export function createRendererGpuStallWatchdog(deps: RendererGpuStallWatchdogDeps): {
  tick: () => void
  /** Drops the outstanding ping; call when the renderer reloads or dies. */
  reset: () => void
} {
  const now = deps.now ?? (() => performance.now())
  let outstanding: OutstandingPing | null = null
  let lastTickAt: number | null = null
  let kills = 0

  const hasLowCpuUsage = (ping: OutstandingPing, at: number): boolean => {
    const cpuSeconds = deps.readRendererCpuSeconds()
    if (
      cpuSeconds === null ||
      ping.cpuSecondsAtStart === null ||
      !Number.isFinite(cpuSeconds) ||
      !Number.isFinite(ping.cpuSecondsAtStart) ||
      cpuSeconds < ping.cpuSecondsAtStart
    ) {
      return false
    }
    const share = ((cpuSeconds - ping.cpuSecondsAtStart) * 1_000) / Math.max(1, at - ping.startedAt)
    return share <= BUSY_RENDERER_CPU_SHARE
  }

  const sendPing = (at: number, gpu: GpuProcessIdentity): void => {
    const cpuSecondsAtStart = deps.readRendererCpuSeconds()
    if (
      cpuSecondsAtStart === null ||
      !Number.isFinite(cpuSecondsAtStart) ||
      cpuSecondsAtStart < 0
    ) {
      return
    }
    const ping: OutstandingPing = {
      startedAt: at,
      deadline: at + RENDERER_GPU_STALL_TIMEOUT_MS,
      cpuSecondsAtStart,
      gpu
    }
    outstanding = ping
    const settle = (): void => {
      if (outstanding === ping) {
        outstanding = null
      }
    }
    try {
      deps.pingRenderer().then(settle, settle)
    } catch {
      settle()
    }
  }

  const tick = (): void => {
    const at = now()
    // Why: a tick gap means OS sleep froze both sides; an old ping proves nothing.
    const slept = lastTickAt !== null && at - lastTickAt > RENDERER_GPU_STALL_PING_INTERVAL_MS * 3
    lastTickAt = at
    if (slept || !deps.canPing()) {
      outstanding = null
      return
    }
    if (kills >= RENDERER_GPU_STALL_MAX_KILLS) {
      return
    }
    const recentCrashes = deps
      .readGpuCrashTimes()
      .filter(
        (crashedAt) =>
          Number.isFinite(crashedAt) &&
          crashedAt >= 0 &&
          crashedAt <= at &&
          at - crashedAt <= DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS
      )
    // Leave crash bursts to the existing safe-graphics policy.
    if (recentCrashes.length !== 1) {
      outstanding = null
      return
    }
    const gpuProcesses = deps.readGpuProcesses()
    const [gpu] = gpuProcesses
    if (
      gpuProcesses.length !== 1 ||
      gpu === undefined ||
      !Number.isSafeInteger(gpu.pid) ||
      gpu.pid <= 0 ||
      !Number.isFinite(gpu.creationTime) ||
      gpu.creationTime <= 0
    ) {
      outstanding = null
      return
    }
    if (
      !outstanding ||
      outstanding.gpu.pid !== gpu.pid ||
      outstanding.gpu.creationTime !== gpu.creationTime
    ) {
      sendPing(at, gpu)
      return
    }
    if (at < outstanding.deadline || !hasLowCpuUsage(outstanding, at)) {
      return
    }
    const stalledMs = at - outstanding.startedAt
    kills += 1
    try {
      deps.killProcess(gpu.pid)
    } catch {
      return
    }
    deps.onGpuKilled({ stalledMs, gpuPids: [gpu.pid], kills })
  }

  const reset = (): void => {
    outstanding = null
  }

  return { tick, reset }
}

type GpuWatchdogWindow = Pick<BrowserWindow, 'isDestroyed'> & {
  webContents: Pick<
    BrowserWindow['webContents'],
    'getOSProcessId' | 'isDestroyed' | 'isCrashed' | 'isLoadingMainFrame' | 'isDevToolsOpened'
  > & {
    executeJavaScript: (script: string) => Promise<unknown>
    on(event: 'did-start-loading', callback: () => void): unknown
    on(event: 'render-process-gone', callback: () => void): unknown
    off(event: 'did-start-loading', callback: () => void): unknown
    off(event: 'render-process-gone', callback: () => void): unknown
  }
}

export function installRendererGpuStallWatchdog(
  mainWindow: GpuWatchdogWindow,
  readGpuCrashTimes: () => readonly number[]
): () => void {
  if (process.platform !== 'win32') {
    return () => {}
  }
  const { webContents } = mainWindow
  const readRendererMetric = (): Electron.ProcessMetric | undefined => {
    const pid = webContents.getOSProcessId()
    return app.getAppMetrics().find((metric) => metric.pid === pid)
  }
  const watchdog = createRendererGpuStallWatchdog({
    pingRenderer: () => webContents.executeJavaScript('0'),
    canPing: () =>
      !mainWindow.isDestroyed() &&
      !webContents.isDestroyed() &&
      !webContents.isCrashed() &&
      !webContents.isLoadingMainFrame() &&
      !webContents.isDevToolsOpened(),
    readRendererCpuSeconds: () => readRendererMetric()?.cpu.cumulativeCPUUsage ?? null,
    readGpuCrashTimes,
    readGpuProcesses: () => {
      const gpuMetrics = app.getAppMetrics().filter((metric) => metric.type === 'GPU')
      const [gpu] = gpuMetrics
      return gpuMetrics.length === 1 && gpu?.memory.workingSetSize === 0
        ? [{ pid: gpu.pid, creationTime: gpu.creationTime }]
        : []
    },
    killProcess: (pid) => process.kill(pid, 'SIGKILL'),
    onGpuKilled: (info) => {
      console.warn('[gpu] renderer stalled on GPU process; killed it to recover', info)
      recordDurableCrashBreadcrumb('renderer_gpu_stall_gpu_killed', {
        stalledMs: info.stalledMs,
        gpuPid: info.gpuPids[0],
        kills: info.kills
      })
    }
  })
  // Why: executeJavaScript never settles once its renderer reloads or crashes.
  webContents.on('did-start-loading', watchdog.reset)
  webContents.on('render-process-gone', watchdog.reset)
  const timer = setInterval(watchdog.tick, RENDERER_GPU_STALL_PING_INTERVAL_MS)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    if (!webContents.isDestroyed()) {
      webContents.off('did-start-loading', watchdog.reset)
      webContents.off('render-process-gone', watchdog.reset)
    }
  }
}
