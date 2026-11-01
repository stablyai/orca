import type { SideRailStrip } from '../layout/side-rail-strip'

/** The rail is free only while chat is collapsed, a status column exists, and the keyboard is down. */
export function duoRailBackVisible(args: {
  chatVisible: boolean
  expanded: boolean
  strip: SideRailStrip | null
  keyboardInset: number
}): boolean {
  return (
    args.chatVisible && !args.expanded && args.strip !== null && !(args.keyboardInset > 0)
  )
}

/**
 * Page sessions walk Back claims, then ask the shell to pop. Anything else uses the session's own back.
 * A true page result already navigated, so the native path must not run again.
 */
export function performSessionRailBack(
  pageBack: (() => boolean) | null,
  nativeBack: () => void
): void {
  if (pageBack?.() === true) {
    return
  }
  nativeBack()
}
