export function shouldQuitWhenAllWindowsClosed(options: {
  platform: NodeJS.Platform
  isQuitting: boolean
  isServeMode: boolean
}): boolean {
  if (options.isServeMode) {
    return false
  }
  return options.platform !== 'darwin' || options.isQuitting
}
