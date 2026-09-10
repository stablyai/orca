import { app } from 'electron'
import {
  DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
  GPU_FALLBACK_CRASH_REASONS,
  isGpuChildProcessType,
  type GpuCrashFallbackTracker
} from '../crash-reporting/gpu-crash-fallback-decision'
import { writeGpuFallbackMarker, type LinuxGpuFallbackEnvironment } from './gpu-fallback-marker'

export function isLinuxDevGpuFallbackSession(options: {
  platform: NodeJS.Platform
  isDev: boolean
  isServeMode: boolean
}): boolean {
  return options.platform === 'linux' && options.isDev && !options.isServeMode
}

type LinuxDevGpuWatchDependencies = {
  tracker: GpuCrashFallbackTracker
  resolveMarkerEnvironment(): LinuxGpuFallbackEnvironment | null
  resolveUserDataPath(): string
  nowMs?: () => number
  log?: (message: string) => void
  warn?: (message: string) => void
  exit?: (exitCode: number) => void
}

/**
 * Why: on Linux dev hosts every GPU child launch fails (error_code=1002 burst) until Chromium
 * fatal-exits with "GPU process isn't usable", dragging `pnpm dev` into a resubscribe/zombie loop.
 * The shared child-process-gone handler registers only post-window and is win32-gated, so this
 * pre-window listener persists the build-scoped marker that software-renders the next launch.
 */
export function installLinuxDevGpuFailureWatch(dependencies: LinuxDevGpuWatchDependencies): void {
  const now = dependencies.nowMs ?? (() => performance.now())
  const log = dependencies.log ?? ((message: string) => console.error(message))
  const warn = dependencies.warn ?? ((message: string) => console.warn(message))
  const exit = dependencies.exit ?? ((code: number) => app.exit(code))

  app.on('child-process-gone', (_event, details) => {
    if (!isGpuChildProcessType(details.type) || !GPU_FALLBACK_CRASH_REASONS.has(details.reason)) {
      return
    }
    const result = dependencies.tracker.recordGpuCrash(now())
    log(
      `[gpu-fallback] GPU child ${details.reason} (${result.crashesInWindow}/${DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD} in window)`
    )
    if (!result.shouldEngageFallback) {
      return
    }
    const environment = dependencies.resolveMarkerEnvironment()
    if (!environment) {
      return
    }
    try {
      writeGpuFallbackMarker(
        dependencies.resolveUserDataPath(),
        { engagedAt: Date.now(), crashesInWindow: result.crashesInWindow },
        environment
      )
    } catch (error) {
      warn(
        `[gpu-fallback] failed to persist marker: ${error instanceof Error ? error.message : String(error)}`
      )
      return
    }
    // Why: exit instead of relaunch — electron-vite owns the dev URL, so a relaunched Electron
    // would load a dead Vite origin; quitting also stops parcel-watcher resubscribe churn.
    log(
      '[gpu-fallback] GPU child launches keep failing in this Linux dev session; hardware acceleration is disabled for the next launch. Rerun `pnpm dev`.'
    )
    exit(1)
  })
}
