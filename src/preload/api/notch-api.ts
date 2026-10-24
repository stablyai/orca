import type { NotchFocusPaneRequest, NotchSnapshot } from '../../shared/notch/notch-snapshot'

export type NotchApi = {
  /** Push-only feed for the macOS notch status window; no-op elsewhere. */
  onSnapshot: (callback: (snapshot: NotchSnapshot) => void) => () => void
  /** Mirrors the renderer's acknowledgeAgents so main can clear the finished lane. */
  acknowledgePanes: (paneKeys: string[]) => void
  /** Notch renderer only — main owns the window size, so it resizes then re-publishes. */
  setExpanded: (expanded: boolean) => void
  /** Notch renderer only — opts the window in/out of OS-level click capture. */
  setInteractive: (interactive: boolean) => void
  focusPane: (args: NotchFocusPaneRequest) => void
  /** Main-window side: navigate to a pane the user picked in the notch panel. */
  onRevealPane: (callback: (args: NotchFocusPaneRequest) => void) => () => void
  /** Main-window side: tells main the reveal listener is attached, flushing any buffered one. */
  notifyRevealReady: () => void
}
