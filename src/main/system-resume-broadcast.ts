import { BrowserWindow, powerMonitor } from 'electron'
import { recordCrashBreadcrumb } from './crash-reporting/crash-breadcrumb-store'
import { publishSystemResume, publishSystemSuspend } from './system-power-lifecycle'

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

// Short sleeps cannot explain a multi-minute heartbeat gap; save breadcrumb slots.
const MIN_REPORTABLE_SUSPEND_MS = 60_000

// Renderers cannot observe OS wake directly, including through visibilitychange on Linux.
export function registerSystemResumeBroadcast(
  options: SystemResumeBroadcastOptions = {}
): () => void {
  const resumeSource = options.resumeSource ?? powerMonitor
  const getWindows = options.getWindows ?? (() => BrowserWindow.getAllWindows())
  const now = options.now ?? Date.now
  let suspendedAt: number | null = null

  const onSuspend = (): void => {
    // Dark wake can re-suspend without resume; retain the earliest stamp to explain the full gap.
    suspendedAt ??= now()
    publishSystemSuspend()
  }

  const onResume = (): void => {
    const suspendedForMs = suspendedAt === null ? null : Math.max(0, now() - suspendedAt)
    suspendedAt = null
    if (suspendedForMs !== null && suspendedForMs >= MIN_REPORTABLE_SUSPEND_MS) {
      recordCrashBreadcrumb('system_slept', { suspendedForMs })
    }
    publishSystemResume()
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
