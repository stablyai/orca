export function shouldQuitWhenAllWindowsClosed(options: {
  platform: NodeJS.Platform
  isQuitting: boolean
  isQuittingForUpdate?: boolean
  isServeMode: boolean
}): boolean {
  const quitCommitted = options.isQuitting || options.isQuittingForUpdate === true
  if (options.isServeMode && !quitCommitted) {
    return false
  }
  return options.platform !== 'darwin' || quitCommitted
}
