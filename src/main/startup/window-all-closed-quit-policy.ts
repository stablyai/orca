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
