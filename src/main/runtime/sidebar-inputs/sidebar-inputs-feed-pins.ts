import type { SidebarInputsReadResult } from '../../../shared/sidebar-list/sidebar-inputs-feed-contract'

/** A multi-page batch stays readable this long after its last page read. */
export const FEED_PIN_IDLE_MS = 30_000
export const FEED_PIN_MAX_BYTES = 16 * 1024 * 1024
export const FEED_PIN_MAX_BATCHES = 8

type Pin = { pages: readonly SidebarInputsReadResult[]; bytes: number; expiresAt: number }

/** Pin immutable batches for shared page-token reads within count/byte bounds; one oversized batch may be pinned alone. */
export class FeedPins {
  /** By batch key, oldest first. */
  private readonly pins = new Map<string, Pin>()

  /** The batch pinned under `key`, if still readable. */
  find(key: string): readonly SidebarInputsReadResult[] | null {
    const pin = this.live(key)
    return pin ? pin.pages : null
  }

  /** The page a token names; null once its batch expired or was evicted. */
  page(token: string): SidebarInputsReadResult | null {
    const split = token.lastIndexOf('#')
    return this.live(token.slice(0, split))?.pages[Number(token.slice(split + 1))] ?? null
  }

  add(key: string, pages: readonly SidebarInputsReadResult[], bytes: number): void {
    const now = Date.now()
    let total = bytes
    for (const [existing, pin] of this.pins) {
      if (pin.expiresAt <= now) {
        this.pins.delete(existing)
      } else {
        total += pin.bytes
      }
    }
    for (const [existing, pin] of this.pins) {
      if (total <= FEED_PIN_MAX_BYTES && this.pins.size < FEED_PIN_MAX_BATCHES) {
        break
      }
      this.pins.delete(existing)
      total -= pin.bytes
    }
    this.pins.set(key, { pages, bytes, expiresAt: now + FEED_PIN_IDLE_MS })
  }

  private live(key: string): Pin | null {
    const pin = this.pins.get(key)
    if (!pin || pin.expiresAt <= Date.now()) {
      return null
    }
    pin.expiresAt = Date.now() + FEED_PIN_IDLE_MS
    return pin
  }
}

/** The token of a pinned batch's page. */
export function feedPageToken(key: string, index: number): string {
  return `${key}#${index}`
}
