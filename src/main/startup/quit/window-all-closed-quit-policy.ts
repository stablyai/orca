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
