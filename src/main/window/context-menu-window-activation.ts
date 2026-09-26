import type { App, BrowserWindow } from 'electron'
import { safelyFocusApp } from './focus-existing-window'
import { isBackgroundLaunch, type PolicyEnv } from './foreground-activation-policy'

export type ContextMenuActivationInput = {
  type?: string
  button?: string
  modifiers?: readonly string[]
}

/** Only the 'input-event' subscription of a WebContents, so tests can stand one up without casts. */
export type ContextMenuInputEventTarget = {
  on: (
    channel: 'input-event',
    listener: (event: unknown, input: ContextMenuActivationInput) => void
  ) => unknown
}

export type ContextMenuWindowActivationOptions = {
  webContents: ContextMenuInputEventTarget
  window: Pick<BrowserWindow, 'isDestroyed' | 'isFocused' | 'focus'>
  app: Pick<App, 'focus'>
  platform?: NodeJS.Platform
  env?: PolicyEnv
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
  const env = options.env ?? process.env
  webContents.on('input-event', (_event, input) => {
    // Why: an automated run drives synthetic clicks; taking the foreground there would sit on the developer's desktop.
    if (window.isDestroyed() || isBackgroundLaunch(env)) {
      return
    }
    if (!shouldActivateWindowForContextMenuInput(input, window.isFocused(), platform)) {
      return
    }
    safelyFocusApp(app)
    window.focus()
  })
}
