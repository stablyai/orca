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

/** Whether a desktop Quit (⌘Q / app.quit) should tear down this process. */
export function shouldCommitDesktopQuit(options: {
  isServeMode: boolean
  isUpdateQuit: boolean
}): boolean {
  // Why: serve-hosted windows share the headless process. Window close already
  // keeps that runtime alive; Cmd+Q must not set isQuitting and drop remotes.
  if (options.isUpdateQuit) {
    return true
  }
  return !options.isServeMode
}
