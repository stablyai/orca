import type { BrowserWindow } from 'electron'

export type MainWindowOpenPolicyArgs = {
  experimentalMultiWindowEnabledAtStartup: boolean
  forceNewWindow?: boolean
  existingWindow: BrowserWindow | null
}

export function shouldReuseExistingMainWindow(args: MainWindowOpenPolicyArgs): boolean {
  return (
    !args.experimentalMultiWindowEnabledAtStartup &&
    args.existingWindow !== null &&
    !args.existingWindow.isDestroyed()
  )
}

export function revealExistingMainWindow(window: BrowserWindow): BrowserWindow {
  if (window.isMinimized()) {
    window.restore()
  }
  window.show()
  window.focus()
  return window
}
