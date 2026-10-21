import { scrollWritesStopMomentum } from './mobile-native-chat-page-motion'

type Styled = {
  style?: { overflowAnchor: string }
  scrollTop: number
  getBoundingClientRect: () => unknown
}

/** Who keeps a parked reader's place where the browser has scroll anchoring (not WebKit): the
 *  browser, which sees every change inside the rows on screen, except while the page owns the
 *  scroll: following (its end pin) or a place-hold's own correction. Two owners would each put the
 *  same move back. */
export class MobileNativeChatPageAnchoring {
  private holds = 0
  private readonly none = scrollWritesStopMomentum()

  constructor(
    private readonly scroller: () => Styled | null | undefined,
    private readonly following: () => boolean
  ) {}

  /** The page takes the scroll for one correction, or gives it back. */
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
    // Laid out under the old owner first, and the new one in force before anything changes.
    s.getBoundingClientRect()
    s.style.overflowAnchor = next
    s.getBoundingClientRect()
    if (next === 'auto') {
      // Not one kept from before the page's turn, whose move the browser would then put back too.
      this.rechoose(s)
    }
  }

  /** After each commit. While the browser holds the place, rows new on screen can't be its anchor
   *  until laid out, so it kept the container around them, whose top never moves. Laid out now, a
   *  scroll makes it choose among them. */
  committed(): void {
    this.sync()
    const s = this.scroller()
    if (this.none || this.holds > 0 || s?.style?.overflowAnchor !== 'auto') {
      return
    }
    s.getBoundingClientRect()
    this.rechoose(s)
  }

  /** A scroll makes the browser choose its anchor afresh; at the very top it keeps none anyway. It
   *  ends where it started, so the scroll event after it reports only what else moved the scroll;
   *  taken as the page's own writes, a reader's scroll landing there would be too. */
  private rechoose(s: Styled): void {
    const top = s.scrollTop
    if (top >= 0.5) {
      s.scrollTop = top - 1
      s.scrollTop = top
    }
  }
}
