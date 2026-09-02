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

// Why: a sleep shorter than the renderer's 60s memory-sample interval only delays a
// heartbeat, it cannot open the multi-minute gap this attributes -- so recording one
// spends a slot in the 30-entry ring without explaining anything.
const MIN_REPORTABLE_SUSPEND_MS = 60_000

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
    // Why: resume maps to NSWorkspaceDidWake, which stays silent for dark wake, so
    // suspend can repeat before a resume. Keep the earliest stamp: over-reporting the
    // span is visibly inconsistent with surviving heartbeats, while under-reporting
    // leaves a long gap looking unexplained -- the false freeze this exists to rule out.
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
