import { BrowserWindow, powerMonitor } from 'electron'
import { recordCrashBreadcrumb } from './crash-reporting/crash-breadcrumb-store'

export const SYSTEM_RESUMED_CHANNEL = 'system:resumed'

type PowerLifecycleEvent = 'suspend' | 'resume'

type ResumeEventSource = {
  on(event: PowerLifecycleEvent, listener: () => void): unknown
  off(event: PowerLifecycleEvent, listener: () => void): unknown
}

type ResumeBroadcastWindow = {
  isDestroyed(): boolean
  webContents: { send(channel: string): void }
}

type SystemResumeBroadcastOptions = {
  resumeSource?: ResumeEventSource
  getWindows?: () => ResumeBroadcastWindow[]
  now?: () => number
}

// Why: renderers cannot observe OS sleep/wake directly, and Linux has no
// window-occlusion tracking so visibilitychange never fires around suspend.
// Wake-sensitive renderer recovery needs this explicit resume signal.
export function registerSystemResumeBroadcast(
  options: SystemResumeBroadcastOptions = {}
): () => void {
  const resumeSource = options.resumeSource ?? powerMonitor
  const getWindows = options.getWindows ?? (() => BrowserWindow.getAllWindows())
  const now = options.now ?? Date.now
  // Why: renderer timers stop across OS sleep, so an unexplained heartbeat gap
  // reads identically to a freeze. Stamping suspend lets resume report the span.
  let suspendedAt: number | null = null

  const onSuspend = (): void => {
    suspendedAt = now()
    recordCrashBreadcrumb('system_suspended')
  }

  const onResume = (): void => {
    const suspendedForMs = suspendedAt === null ? undefined : Math.max(0, now() - suspendedAt)
    suspendedAt = null
    recordCrashBreadcrumb('system_resumed', suspendedForMs === undefined ? {} : { suspendedForMs })
    for (const window of getWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(SYSTEM_RESUMED_CHANNEL)
      }
    }
  }

  resumeSource.on('suspend', onSuspend)
  resumeSource.on('resume', onResume)
  return () => {
    resumeSource.off('suspend', onSuspend)
    resumeSource.off('resume', onResume)
  }
}
