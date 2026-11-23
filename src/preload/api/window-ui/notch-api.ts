import type { NotchFocusPaneRequest, NotchSnapshot } from '../../../shared/notch/notch-snapshot'

export type NotchApi = {
  onSnapshot: (listener: (snapshot: NotchSnapshot) => void) => () => void
  setViewedPanes: (paneKeys: readonly string[]) => void
  acknowledgePanes: (paneKeys: readonly string[]) => void
  setExpanded: (expanded: boolean) => void
  setInteractive: (interactive: boolean) => void
  focusPane: (paneKey: string) => void
  onRevealPane: (listener: (target: NotchFocusPaneRequest) => void) => () => void
  notifyRevealReady: () => void
}
