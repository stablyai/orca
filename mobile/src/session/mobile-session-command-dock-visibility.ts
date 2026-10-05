/** Whether the terminal input dock shows: only under a visible terminal, never over chat or a spinner. */
export function isTerminalCommandDockVisible(view: {
  activeMarkdownTab: unknown
  activeFileTab: unknown
  activeBrowserTab: unknown
  showNativeChat: boolean
  /** The active leaf's view is still settling, so no terminal is on screen to type into. */
  activeViewUndecided: boolean
}): boolean {
  return (
    !view.activeMarkdownTab &&
    !view.activeFileTab &&
    !view.activeBrowserTab &&
    !view.showNativeChat &&
    !view.activeViewUndecided
  )
}
