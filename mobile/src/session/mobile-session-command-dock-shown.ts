import type { MobileSessionController } from './use-mobile-session-controller'

// Markdown, file, browser and chat tabs bring their own input; only terminals get the dock and its keys.
export function sessionCommandDockShown(controller: MobileSessionController): boolean {
  return (
    !controller.activeMarkdownTab &&
    !controller.activeFileTab &&
    !controller.activeBrowserTab &&
    !controller.showNativeChat
  )
}
