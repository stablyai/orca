/** No touch and no scroll of the reader's for this long: a write any sooner can stop iOS momentum. */
const REST_MS = 150
/** Input this recent makes a move the reader's where the browser also moves the scroll. */
const INTENT_MS = 1_000
const SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' '])
type Moved = { by: 'own' | 'layout' | 'reader' | 'none'; moved: number }

// WebKit scroll writes stop flings and it lacks anchoring; other engines preserve momentum and anchor parked readers.
export function scrollWritesStopMomentum(): boolean {
  const agent = globalThis.navigator?.userAgent ?? ''
  return /AppleWebKit/.test(agent) && !/Chrome|Chromium|Android/.test(agent)
}

// Keep place manually on WebKit and at top, where Chromium anchoring does not adjust.
export function scrollKeepsPlace(scrollTop: number): boolean {
  return scrollWritesStopMomentum() || scrollTop < 0.5
}

type Listener = (event: unknown) => void
type Listened = {
  addEventListener: (type: string, listener: Listener, options: { passive: true }) => void
  removeEventListener: (type: string, listener: Listener) => void
}

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

export class MobileNativeChatScrollMotion {
  private touching = false
  private pointing = false
  private lastInput = 0
  private way = 0
  private lastTouchY: number | undefined
  private lastReaderScroll = 0
  // Where browser anchoring also scrolls, require reader input to attribute movement to the reader.
  private readonly browserMoves = !scrollWritesStopMomentum()
  private seen = 0
  private seenMax = Infinity
  // Until post-commit resize reconciliation, attribute movement to layout.
  private unreconciled = false
  private drawn = ''
  private layouts = 0
  private own: number[] = []

  constructor(initialTop = 0) {
    this.seen = initialTop
  }

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
      input(from !== undefined && y !== undefined && y !== from ? Math.sign(from - y) : this.way)
    }
    const start = (event: unknown) => {
      this.lastTouchY = touchY(event)
      input(0)
      this.touch(true)
    }
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
    // Scrollbar release and scroll keys may arrive outside the scroller.
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

  // Scroll events precede resize callbacks; treat changed draws as unreconciled layout until resize or next frame.
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

  reconciled(scrollTop: number, max: number): Moved {
    this.unreconciled = false
    return this.account(scrollTop, max)
  }

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

  // Distinguish shorter-content clamps from reader motion; browser anchoring requires recent input moving in the same direction.
  private account(scrollTop: number, max: number): Moved {
    const [from, fromMax, moved] = [this.seen, this.seenMax, scrollTop - this.seen]
    ;[this.seen, this.seenMax] = [scrollTop, max]
    if (Math.abs(moved) < 0.5) {
      return { by: 'none', moved }
    }
    // A shorter-end clamp is layout movement; iOS overscroll beyond the old end is not.
    const clamped = Math.abs(scrollTop - max) < 0.5 && from > max + 0.5 && from <= fromMax + 0.5
    if ((clamped && !this.touching) || (this.browserMoves && !this.intended(moved))) {
      return { by: 'layout', moved }
    }
    this.lastReaderScroll = Date.now()
    return { by: 'reader', moved }
  }

  // Match recent input direction so opposing browser-anchor corrections cannot detach a following reader.
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

  readonly mayCorrect = scrollWritesStopMomentum() ? () => this.settled() : () => true

  release(): void {
    this.touching = false
    this.pointing = false
    this.lastReaderScroll = 0
    this.own = []
  }
}
