export function shouldQuitWhenAllWindowsClosed(options: {
  platform: NodeJS.Platform
  isQuitting: boolean
  isServeMode: boolean
}): boolean {
  if (options.isServeMode && !options.isQuitting) {
    return false
  }
  return options.platform !== 'darwin' || options.isQuitting
}

/**
 * Whether closing the last window ends the app outside a quit: true on Windows/Linux desktop,
 * where `window-all-closed` then quits through the same teardown as File > Quit.
 */
export function closingLastWindowQuitsApp(options: {
  platform: NodeJS.Platform
  isServeMode: boolean
}): boolean {
  return shouldQuitWhenAllWindowsClosed({ ...options, isQuitting: false })
}
