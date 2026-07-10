import { BrowserWindow, powerMonitor } from 'electron'

export const SYSTEM_RESUMED_CHANNEL = 'system:resumed'

type ResumeEventSource = {
  on(event: 'resume', listener: () => void): unknown
  off(event: 'resume', listener: () => void): unknown
}

type ResumeBroadcastWindow = {
  isDestroyed(): boolean
  webContents: { send(channel: string): void }
}

type SystemResumeBroadcastOptions = {
  resumeSource?: ResumeEventSource
  getWindows?: () => ResumeBroadcastWindow[]
}

// Why: renderers cannot observe OS sleep/wake directly, and Linux has no
// window-occlusion tracking so visibilitychange never fires around suspend.
// Wake-sensitive renderer recovery needs this explicit resume signal.
export function registerSystemResumeBroadcast(
  options: SystemResumeBroadcastOptions = {}
): () => void {
  const resumeSource = options.resumeSource ?? powerMonitor
  const getWindows = options.getWindows ?? (() => BrowserWindow.getAllWindows())
  const onResume = (): void => {
    for (const window of getWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(SYSTEM_RESUMED_CHANNEL)
      }
    }
  }
  resumeSource.on('resume', onResume)
  return () => {
    resumeSource.off('resume', onResume)
  }
}
