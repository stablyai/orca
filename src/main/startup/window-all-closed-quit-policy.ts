export function shouldQuitWhenAllWindowsClosed(options: {
  platform: NodeJS.Platform
  isQuitting: boolean
  isServeMode: boolean
  hasOpenedMainWindow: boolean
}): boolean {
  if (options.isQuitting) {
    return true
  }
  // Hidden helper windows (extension native pages) can close before the first main window exists.
  if (options.isServeMode || !options.hasOpenedMainWindow) {
    return false
  }
  return options.platform !== 'darwin'
}

/**
 * Whether closing the last window ends the app outside a quit: true on Windows/Linux desktop,
 * where `window-all-closed` then quits through the same teardown as File > Quit.
 */
export function closingLastWindowQuitsApp(options: {
  platform: NodeJS.Platform
  isServeMode: boolean
}): boolean {
  // Asked from the main window's own close, so that window has opened.
  return shouldQuitWhenAllWindowsClosed({
    ...options,
    isQuitting: false,
    hasOpenedMainWindow: true
  })
}
