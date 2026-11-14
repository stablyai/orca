import { scrollWritesStopMomentum } from './mobile-native-chat-scroll-motion'

type Styled = {
  style?: { overflowAnchor: string }
  scrollTop: number
  getBoundingClientRect: () => unknown
}

// Give scroll anchoring one owner: the browser normally, the box while following or restoring. Two owners would apply the same correction twice.
export class MobileNativeChatScrollAnchoring {
  private holds = 0
  private readonly none = scrollWritesStopMomentum()

  constructor(
    private readonly scroller: () => Styled | null | undefined,
    private readonly following: () => boolean
  ) {}

  hold(on: boolean): void {
    this.holds = Math.max(0, this.holds + (on ? 1 : -1))
    this.sync()
  }

  sync(): void {
    const s = this.scroller()
    const next = this.holds === 0 && !this.following() ? 'auto' : 'none'
    if (this.none || !s?.style || s.style.overflowAnchor === next) {
      return
    }
    // Flush layout under the old owner before changing ownership.
    s.getBoundingClientRect()
    s.style.overflowAnchor = next
    s.getBoundingClientRect()
    if (next === 'auto') {
      // Do not retain the browser’s pre-correction anchor or it would undo the page’s move too.
      this.rechoose(s)
    }
  }

  // After layout, force anchor reselection among newly visible rows; the old container anchor has an unmoving top.
  committed(): void {
    this.sync()
    const s = this.scroller()
    if (this.none || this.holds > 0 || s?.style?.overflowAnchor !== 'auto') {
      return
    }
    s.getBoundingClientRect()
    this.rechoose(s)
  }

  // A reversible scroll resets browser anchor selection; leave subsequent scroll events available to report real reader movement.
  private rechoose(s: Styled): void {
    const top = s.scrollTop
    if (top >= 0.5) {
      s.scrollTop = top - 1
      s.scrollTop = top
    }
  }
}
