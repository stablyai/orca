type Scroller = { getBoundingClientRect: () => { top: number }; scrollTop: number }
import { mobileNativeChatScrollFrame } from './mobile-native-chat-scroll-roots'

function isElement(node: unknown): node is Element {
  return typeof Element !== 'undefined' && node instanceof Element
}

/** The part of `row` at the screen's top line `view`: the first part starting on screen, or the
 *  innermost one crossing the line, as the browser's own scroll anchoring would pick. Growth above
 *  it inside the row then moves it, which the row's own top doesn't show. */
function partAtTop(row: Element, view: number): Element {
  let part = row
  for (let child = row.firstElementChild; child;) {
    const box = child.getBoundingClientRect()
    if (box.bottom <= view || box.height === 0) {
      child = child.nextElementSibling
    } else if (mobileNativeChatScrollFrame(child, row) || box.top >= view) {
      return child
    } else {
      part = child
      child = child.firstElementChild
    }
  }
  return part
}

/** The page's drawn row nodes by key, each in the one observer while drawn, and the row the reader
 *  is reading: the first drawn row on screen and its offset from the scroller's top. */
export class MobileNativeChatPageRows {
  private nodes = new Map<string, Element>()
  private keys = new WeakMap<Element, string>()
  private refs = new Map<string, (node: unknown) => void>()
  private observer: ResizeObserver | null = null
  /** The row and the part of it at the screen's top; `top` from the scroller's top, with the
   *  `scrollTop` it was read at. */
  private anchor: { key: string; part: Element; top: number; scrollTop: number } | null = null

  keyOf(node: Element): string | undefined {
    return this.keys.get(node)
  }

  node(key: string | undefined): Element | undefined {
    return key === undefined ? undefined : this.nodes.get(key)
  }

  readonly observeWith = (observer: ResizeObserver | null): void => {
    this.observer = observer
    this.nodes.forEach((node) => observer?.observe(node))
  }

  /** One ref per key for as long as the row is drawn, so a streamed commit never re-observes it. */
  readonly ref = (key: string): ((node: unknown) => void) => {
    let ref = this.refs.get(key)
    if (!ref) {
      ref = (node: unknown) => {
        const was = this.nodes.get(key)
        if (was) {
          this.observer?.unobserve(was)
          this.nodes.delete(key)
        }
        if (isElement(node)) {
          this.nodes.set(key, node)
          this.keys.set(node, key)
          this.observer?.observe(node)
        } else {
          this.refs.delete(key)
        }
      }
      this.refs.set(key, ref)
    }
    return ref
  }

  /** `deep`: anchor the part of the row at the screen's top, not the row's own top. */
  takeAnchor(
    scroller: Scroller,
    keys: readonly string[],
    [start, end]: [number, number],
    deep: boolean
  ): void {
    const view = scroller.getBoundingClientRect().top
    let [low, high] = [start, end]
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2)
      const node = this.node(keys[middle])
      if (!node || node.getBoundingClientRect().bottom <= view) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    const key = keys[low]
    const node = this.node(key)
    const part = node && (deep ? partAtTop(node, view) : node)
    const top = part && part.getBoundingClientRect().top - view
    this.anchor =
      key && part && top !== undefined ? { key, part, top, scrollTop: scroller.scrollTop } : null
  }

  /** How far the anchored part moved in the content since it was taken (what is above it changed
   *  size), apart from any scrolling; null when it isn't drawn. */
  placeShift(scroller: Scroller): number | null {
    const part = this.anchor?.part
    if (!this.anchor || !part?.isConnected || !this.node(this.anchor.key)) {
      return null
    }
    const now = part.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    return now + scroller.scrollTop - this.anchor.top - this.anchor.scrollTop
  }

  placeMoved(scroller: Scroller): boolean {
    return Math.abs(this.placeShift(scroller) ?? 0) >= 0.5
  }

  forgetAnchor(): void {
    this.anchor = null
  }
}
