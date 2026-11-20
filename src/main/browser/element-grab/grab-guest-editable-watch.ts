/**
 * Whether a page field has focus while a pick runs, so main can leave a bare letter to the field instead of taking it
 * as a tool key. Why each piece:
 * - An isolated world: page script can neither read nor replace the tracker, so it cannot feed main answers.
 * - A work budget at main: real focus churn (a page focusing in a loop) can't make main and the page trade messages
 *   without limit; while the budget is spent the state is "unknown".
 * - "Unknown" means "a field may have focus": letters stay with the page, never swallowed into a tool action.
 * - One watch per pick: arming a new pick, turning the picker off, navigating or losing the page ends it.
 */
import type { WebContents } from 'electron'

// Clear of Electron's 999 and the 1207/1208/1998/1999 Orca already uses.
export const GRAB_EDITABLE_WATCH_WORLD_ID = 1_209

/** At most this many page round-trips back to back, then one more per refill interval. */
export const GRAB_EDITABLE_WATCH_BURST = 10
export const GRAB_EDITABLE_WATCH_REFILL_MS = 100
/** A reply the page never sends ends the wait after this long; the state is unknown meanwhile. */
const STALLED_REPLY_MS = 10_000

const TRACKER = String.raw`
  var NON_TEXT_INPUTS = ['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'file', 'color', 'range', 'hidden'];
  function deepActiveElement() {
    var el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }
  function takesTyping(el) {
    if (!el) return false;
    var tag = el.tagName;
    // A focused frame's own fields can't be seen from here; let the frame keep its keys.
    if (tag === 'IFRAME' || tag === 'FRAME' || tag === 'OBJECT' || tag === 'EMBED') return true;
    if (el.isContentEditable || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return NON_TEXT_INPUTS.indexOf(String(el.type || 'text').toLowerCase()) === -1;
    // A focused custom element without an open shadow root may hold a field in a closed one; leave it its keys.
    if (tag.indexOf('-') !== -1 && !el.shadowRoot) return true;
    return false;
  }
  function install(token) {
    var editable = takesTyping(deepActiveElement());
    var waiters = [];
    function settle(value) {
      var pending = waiters;
      waiters = [];
      pending.forEach(function(resolve) { resolve(value); });
    }
    function publish() {
      var next = takesTyping(deepActiveElement());
      if (next === editable) return;
      editable = next;
      settle(next);
    }
    // On focusout the next element isn't focused yet; read once focus has settled.
    function publishSoon() { setTimeout(publish, 0); }
    window.addEventListener('focusin', publish, true);
    window.addEventListener('focusout', publishSoon, true);
    return {
      token: token,
      await: function(lastSeen) {
        if (lastSeen !== editable) return Promise.resolve(editable);
        return new Promise(function(resolve) {
          waiters.push(resolve);
          setTimeout(function() {
            var at = waiters.indexOf(resolve);
            if (at !== -1) { waiters.splice(at, 1); resolve(null); }
          }, ${STALLED_REPLY_MS});
        });
      },
      stop: function() {
        window.removeEventListener('focusin', publish, true);
        window.removeEventListener('focusout', publishSoon, true);
        settle(null);
      }
    };
  }
`

/** Installs the tracker for this watch (replacing an older one) and waits for a state different from lastSeen. */
export function buildEditableAwaitScript(token: number, lastSeen: boolean | null): string {
  return `(function() {${TRACKER}
  var current = globalThis.__orcaEditableWatch;
  if (!current || current.token !== ${token}) {
    if (current) current.stop();
    current = install(${token});
    globalThis.__orcaEditableWatch = current;
  }
  return current.await(${JSON.stringify(lastSeen)});
})()`
}

/** One direct read, used when a key must be decided now: does a page field have focus at this moment? */
export function buildEditableNowScript(): string {
  return `(function() {${TRACKER}
  return takesTyping(deepActiveElement());
})()`
}

/** Asks a page now whether a field has focus; anything but a clear "no" counts as a field. */
export async function askGuestHasField(
  guest: Pick<WebContents, 'executeJavaScriptInIsolatedWorld' | 'isDestroyed'>
): Promise<boolean> {
  if (guest.isDestroyed()) {
    return true
  }
  try {
    const reply: unknown = await guest.executeJavaScriptInIsolatedWorld(
      GRAB_EDITABLE_WATCH_WORLD_ID,
      [{ code: buildEditableNowScript() }]
    )
    return reply !== false
  } catch {
    return true
  }
}

export function buildEditableStopScript(token: number): string {
  return `(function() {
  var current = globalThis.__orcaEditableWatch;
  if (current && current.token === ${token}) { current.stop(); delete globalThis.__orcaEditableWatch; }
  return true;
})()`
}

type WatchHost = Pick<
  WebContents,
  'executeJavaScriptInIsolatedWorld' | 'isDestroyed' | 'on' | 'off'
>

let nextToken = 0

/** One pick's view of whether a page field has focus. */
export class GuestEditableWatch {
  private state: boolean | null = null
  private stopped = false
  // A token bucket: up to BURST round-trips at once, refilled one per REFILL_MS.
  private budget = GRAB_EDITABLE_WATCH_BURST
  private refilledAt = Date.now()
  private refillTimer: ReturnType<typeof setTimeout> | null = null
  private readonly token = ++nextToken

  constructor(private readonly guest: WatchHost) {}

  /** Unknown counts as a focused field: letters then stay with the page. */
  get editable(): boolean {
    return this.state ?? true
  }

  /** A key that can move focus (Tab) was pressed; the state is unknown until the page reports again. */
  markUnknown(): void {
    this.state = null
  }

  start(): void {
    this.guest.on('did-start-navigation', this.onNavigation)
    this.guest.on('destroyed', this.stop)
    this.step(null)
  }

  readonly stop = (): void => {
    if (this.stopped) {
      return
    }
    this.stopped = true
    this.state = null
    if (this.refillTimer) {
      clearTimeout(this.refillTimer)
    }
    try {
      this.guest.off('did-start-navigation', this.onNavigation)
      this.guest.off('destroyed', this.stop)
      if (!this.guest.isDestroyed()) {
        void this.guest
          .executeJavaScriptInIsolatedWorld(GRAB_EDITABLE_WATCH_WORLD_ID, [
            { code: buildEditableStopScript(this.token) }
          ])
          .catch(() => {})
      }
    } catch {
      // The guest may already be gone.
    }
  }

  private readonly onNavigation = (
    _event: unknown,
    _url: unknown,
    isInPlace: boolean,
    isMainFrame: boolean
  ): void => {
    // A new document has no tracker; this watch's answers no longer describe the page.
    if (isMainFrame && !isInPlace) {
      this.stop()
    }
  }

  private refill(): void {
    const gained = Math.floor((Date.now() - this.refilledAt) / GRAB_EDITABLE_WATCH_REFILL_MS)
    if (gained > 0) {
      this.budget = Math.min(GRAB_EDITABLE_WATCH_BURST, this.budget + gained)
      this.refilledAt += gained * GRAB_EDITABLE_WATCH_REFILL_MS
    }
  }

  private step(lastSeen: boolean | null): void {
    if (this.stopped || this.guest.isDestroyed()) {
      return
    }
    this.refill()
    if (this.budget < 1) {
      // Spent: answer "unknown" (letters to the page) and ask afresh once a round-trip is available again.
      this.state = null
      this.refillTimer = setTimeout(
        () => {
          this.refillTimer = null
          this.step(null)
        },
        GRAB_EDITABLE_WATCH_REFILL_MS - (Date.now() - this.refilledAt)
      )
      return
    }
    this.budget -= 1
    this.guest
      .executeJavaScriptInIsolatedWorld(GRAB_EDITABLE_WATCH_WORLD_ID, [
        { code: buildEditableAwaitScript(this.token, lastSeen) }
      ])
      .then(
        (reply: unknown) => {
          if (this.stopped) {
            return
          }
          // null: the wait stalled or the tracker was replaced; stay unknown and ask afresh.
          this.state = typeof reply === 'boolean' ? reply : null
          this.step(this.state)
        },
        () => this.stop()
      )
  }
}
