import type { App, BrowserWindow, WebContents } from 'electron'

export type ContextMenuActivationInput = {
  type?: string
  button?: string
  modifiers?: readonly string[]
}

export type ContextMenuWindowActivationOptions = {
  webContents: Pick<WebContents, 'on'>
  window: Pick<BrowserWindow, 'isDestroyed' | 'isFocused' | 'focus'>
  app: Pick<App, 'focus'>
  platform?: NodeJS.Platform
}

// Why: macOS skips activation on a right press, and an unfocused window emits no focus events, so Radix highlights nothing.
export function shouldActivateWindowForContextMenuInput(
  input: ContextMenuActivationInput,
  windowFocused: boolean,
  platform: NodeJS.Platform
): boolean {
  if (windowFocused || input.type !== 'mouseDown') {
    return false
  }
  if (input.button === 'right') {
    return true
  }
  return (
    platform === 'darwin' &&
    input.button === 'left' &&
    (input.modifiers?.includes('control') ?? false)
  )
}

export function installContextMenuWindowActivation(
  options: ContextMenuWindowActivationOptions
): void {
  const { webContents, window, app } = options
  const platform = options.platform ?? process.platform
  webContents.on('input-event', (_event, input) => {
    if (window.isDestroyed()) {
      return
    }
    if (!shouldActivateWindowForContextMenuInput(input, window.isFocused(), platform)) {
      return
    }
    try {
      app.focus({ steal: true })
    } catch {
      // Best-effort; the window focus below still raises the menu's own window.
    }
    window.focus()
  })
}
