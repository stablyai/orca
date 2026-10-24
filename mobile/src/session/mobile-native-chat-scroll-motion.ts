/** No touch and no scroll of the reader's for this long: a write any sooner can stop iOS momentum. */
const REST_MS = 150
/** Input this recent makes a move the reader's where the browser also moves the scroll. */
const INTENT_MS = 1_000
const SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' '])
type Moved = { by: 'own' | 'layout' | 'reader' | 'none'; moved: number }

/** WebKit (every iOS browser, and Safari) stops a fling on any scroll write and has no scroll
 *  anchoring; other engines keep momentum, and their anchoring keeps a parked reader's place. */
export function scrollWritesStopMomentum(): boolean {
  const agent = globalThis.navigator?.userAgent ?? ''
  return /AppleWebKit/.test(agent) && !/Chrome|Chromium|Android/.test(agent)
}

/** Whether a scroll box keeps a parked place itself: on WebKit, which has no scroll anchoring, and at the
 *  very top, where Chromium's anchoring never adjusts (rows measured above would push the reader). */
export function scrollKeepsPlace(scrollTop: number): boolean {
  return scrollWritesStopMomentum() || scrollTop < 0.5
}

type Listener = (event: unknown) => void
type Listened = {
  addEventListener: (type: string, listener: Listener, options: { passive: true }) => void
  removeEventListener: (type: string, listener: Listener) => void
}

/** Which way a scroll key the page scrolls by moves it (1 down, -1 up); 0 for any other key, or one
 *  typed into the composer. */
function keyWay(event: unknown): number {
  if (typeof KeyboardEvent === 'undefined' || !(event instanceof KeyboardEvent)) {
    return 0
  }
  const { key, shiftKey, target } = event
  const typing =
    typeof HTMLElement !== 'undefined' &&
    target instanceof HTMLElement &&
    (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)
  if (typing || !SCROLL_KEYS.has(key)) {
    return 0
  }
  return /Up|Home/.test(key) || (key === ' ' && shiftKey) ? -1 : 1
}

function wheelWay(event: unknown): number {
  const deltaY = typeof event === 'object' && event !== null && 'deltaY' in event && event.deltaY
  return typeof deltaY === 'number' ? Math.sign(deltaY) : 0
}

function touchY(event: unknown): number | undefined {
  const touches = typeof event === 'object' && event !== null && 'touches' in event && event.touches
  const first = touches && typeof touches === 'object' && 0 in touches ? touches[0] : undefined
  const y = typeof first === 'object' && first !== null && 'clientY' in first && first.clientY
  return typeof y === 'number' ? y : undefined
}

/** Whether the reader is moving an inner scroll box, told apart from its own writes: on WebKit a
 *  correction waits until the box settles. */
export class MobileNativeChatScrollMotion {
  private touching = false
  private pointing = false
  private lastInput = 0
  /** Which way the reader's last input moves the page: 1 down, -1 up, 0 unknown (the scrollbar). */
  private way = 0
  private lastTouchY: number | undefined
  private lastReaderScroll = 0
  /** The browser moves the scroll too (its anchoring), so only input makes a move the reader's. */
  private readonly browserMoves = !scrollWritesStopMomentum()
  /** Where the page last accounted for the scroll: its write, an observed scroll, a resize. */
  private seen = 0
  private seenMax = Infinity
  /** A commit changed what is drawn and its resize callback hasn't run: a move now is layout's. */
  private unreconciled = false
  private drawn = ''
  private layouts = 0
  /** Where the page's own writes put the scroller, until their scroll event arrives. */
  private own: number[] = []

  constructor(initialTop = 0) {
    this.seen = initialTop
  }

  /** Follows the reader's hand on the scroller (touch, wheel, scroll keys, the scrollbar); returns
   *  the detach. */
  attach(scroller: Listened, acceptsKey: (event: unknown) => boolean = () => true): () => void {
    const input = (way: number) => {
      ;[this.lastInput, this.way] = [Date.now(), way]
    }
    const key = (event: unknown) => {
      const way = keyWay(event)
      if (way !== 0 && acceptsKey(event)) {
        input(way)
      }
    }
    const move = (event: unknown) => {
      const [from, y] = [this.lastTouchY, touchY(event)]
      this.lastTouchY = y
      // A finger moving up scrolls the page down.
      input(from !== undefined && y !== undefined && y !== from ? Math.sign(from - y) : this.way)
    }
    const start = (event: unknown) => {
      this.lastTouchY = touchY(event)
      input(0)
      this.touch(true)
    }
    // The scrollbar, which is the scroller's own; a press on a row inside is no scroll.
    const point = (event: unknown) => {
      if (
        typeof event === 'object' &&
        event !== null &&
        'target' in event &&
        event.target === scroller
      ) {
        this.pointing = true
        this.way = 0
      }
    }
    // Released, or moving with no button down: a pointerup lost after a scrollbar drag can't stick.
    const up = (event: unknown) => {
      if (!(typeof event === 'object' && event !== null && 'buttons' in event && event.buttons)) {
        this.pointing = false
      }
    }
    const listeners: [Listened, string, Listener][] = [
      [scroller, 'touchstart', start],
      [scroller, 'touchend', () => this.touch(false)],
      [scroller, 'touchcancel', () => this.touch(false)],
      [scroller, 'touchmove', move],
      [scroller, 'wheel', (event) => input(wheelWay(event))],
      [scroller, 'pointerdown', point]
    ]
    // A scrollbar drag can end, and a scroll key arrive, outside the scroller.
    if ('addEventListener' in globalThis) {
      listeners.push([globalThis, 'pointerup', up], [globalThis, 'pointercancel', up])
      listeners.push([globalThis, 'pointermove', up], [globalThis, 'keydown', key])
    }
    listeners.forEach(([target, type, fn]) => target.addEventListener(type, fn, { passive: true }))
    return () => listeners.forEach(([target, type, fn]) => target.removeEventListener(type, fn))
  }

  touch(down: boolean): void {
    this.touching = down
    this.lastInput = Date.now()
    if (down) {
      this.own = []
    }
  }

  /** A commit drew `drawn`. When that changed, a move is layout's until its resize callback (or the
   *  next frame, when nothing resized); scroll events run before that frame's resize callbacks. */
  laidOut(drawn: string): void {
    if (drawn === this.drawn) {
      return
    }
    this.drawn = drawn
    this.unreconciled = true
    const token = ++this.layouts
    globalThis.requestAnimationFrame?.(() => {
      if (token === this.layouts) {
        this.unreconciled = false
      }
    })
  }

  /** The resize callback reconciled layout: what moved the scroll since the page last accounted
   *  for it is now told apart (a scroll event may not have reported it yet). */
  reconciled(scrollTop: number, max: number): Moved {
    this.unreconciled = false
    return this.account(scrollTop, max)
  }

  /** What moved the scroll to `scrollTop` since the page last accounted for it, and by how much. The
   *  page's write; layout while a commit is unreconciled or rows above the reading place moved
   *  (`placeMoved`), left for the resize callback to tell apart; else as `account`. */
  scrolled(scrollTop: number, max: number, placeMoved: () => boolean): Moved {
    const moved = scrollTop - this.seen
    const at = this.own.findIndex((target) => Math.abs(target - scrollTop) <= 1)
    if (at !== -1) {
      this.own.splice(0, at + 1)
      ;[this.seen, this.seenMax] = [scrollTop, max]
      return { by: 'own', moved }
    }
    if (Math.abs(moved) >= 0.5 && !this.touching && (this.unreconciled || placeMoved())) {
      return { by: 'layout', moved }
    }
    return this.account(scrollTop, max)
  }

  /** A clamp onto a shorter end is layout's; any other move is the reader's (a finger makes it so),
   *  except where the browser moves the scroll too: there only input (or the fling it started) does. */
  private account(scrollTop: number, max: number): Moved {
    const [from, fromMax, moved] = [this.seen, this.seenMax, scrollTop - this.seen]
    ;[this.seen, this.seenMax] = [scrollTop, max]
    if (Math.abs(moved) < 0.5) {
      return { by: 'none', moved }
    }
    // Pulled back onto a shorter end from where the old one allowed; iOS bouncing past an end is not.
    const clamped = Math.abs(scrollTop - max) < 0.5 && from > max + 0.5 && from <= fromMax + 0.5
    if ((clamped && !this.touching) || (this.browserMoves && !this.intended(moved))) {
      return { by: 'layout', moved }
    }
    this.lastReaderScroll = Date.now()
    return { by: 'reader', moved }
  }

  /** Input is recent (a fling counts from the finger's release) and the move goes its way: the
   *  browser's anchoring moving against it is the browser's, so it can't detach the reader. */
  private intended(moved: number): boolean {
    const recent = this.touching || this.pointing || Date.now() - this.lastInput <= INTENT_MS
    return recent && (this.way === 0 || Math.sign(moved) === this.way)
  }

  wrote(target: number): void {
    this.own = [...this.own.slice(-7), target]
    this.seen = target
  }

  settled(): boolean {
    return !this.touching && Date.now() - this.lastReaderScroll >= REST_MS
  }

  /** A place correction may be written now: at once where a write keeps momentum (as the common
   *  list does), else only at rest. */
  readonly mayCorrect = scrollWritesStopMomentum() ? () => this.settled() : () => true

  release(): void {
    this.touching = false
    this.pointing = false
    this.lastReaderScroll = 0
    this.own = []
  }
}
