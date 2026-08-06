import { types } from 'node:util'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { buildGuestOverlayScript } from './grab-guest-script'
import { clampGrabPayload } from './browser-grab-payload'

describe('buildGuestOverlayScript', () => {
  it('returns a non-empty string for arm action', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toBeTruthy()
    expect(typeof script).toBe('string')
    expect(script.length).toBeGreaterThan(100)
  })

  it('returns a non-empty string for awaitClick action', () => {
    const script = buildGuestOverlayScript('awaitClick')
    expect(script).toBeTruthy()
    expect(typeof script).toBe('string')
  })

  it('returns a non-empty string for finalize action', () => {
    const script = buildGuestOverlayScript('finalize')
    expect(script).toBeTruthy()
    expect(typeof script).toBe('string')
  })

  it('returns a non-empty string for teardown action', () => {
    const script = buildGuestOverlayScript('teardown')
    expect(script).toBeTruthy()
    expect(typeof script).toBe('string')
  })

  it('arm script contains shadow DOM setup', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toContain('attachShadow')
    expect(script).toContain('__orca-grab-host')
    expect(script).toContain('__orcaGrab')
  })

  it('arm script contains budget constants matching shared types', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toContain('textSnippetMaxLength: 200')
    expect(script).toContain('nearbyTextMaxEntries: 10')
    expect(script).toContain('htmlSnippetMaxLength: 4096')
  })

  it('arm script contains secret pattern redaction', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toContain('access_token')
    expect(script).toContain('api_key')
    expect(script).toContain('password')
    expect(script).toContain('secret')
    expect(script).toContain('[redacted]')
  })

  it('arm script strips script tags from HTML snippets', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toContain("querySelectorAll('script')")
  })

  it('arm script only allows safe attributes', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toContain('SAFE_ATTRS')
    expect(script).toContain("'id'")
    expect(script).toContain("'class'")
    expect(script).toContain("'role'")
  })

  it('awaitClick script returns a Promise', () => {
    const script = buildGuestOverlayScript('awaitClick')
    expect(script).toContain('new Promise')
    expect(script).toContain('resolve')
    expect(script).toContain('reject')
  })

  it('awaitClick script freezes highlight on selection instead of cleanup', () => {
    const script = buildGuestOverlayScript('awaitClick')
    expect(script).toContain('freezeHighlight')
    expect(script).not.toContain('grab.cleanup();\n    resolve')
  })

  it('arm script defines freezeHighlight method', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toContain('freezeHighlight')
    expect(script).toContain("pointerEvents = 'none'")
  })

  it('awaitClick script blocks right-click', () => {
    const script = buildGuestOverlayScript('awaitClick')
    expect(script).toContain('contextmenu')
    expect(script).toContain('preventDefault')
  })

  it('teardown script cleans up the overlay', () => {
    const script = buildGuestOverlayScript('teardown')
    expect(script).toContain('cleanup')
    expect(script).toContain('__orcaGrab')
  })

  it('teardown script cancels pending awaitClick', () => {
    const script = buildGuestOverlayScript('teardown')
    expect(script).toContain('cancelAwait')
    expect(buildGuestOverlayScript('awaitClick')).toContain('__orcaCancelled')
  })

  it('arm script uses full-viewport overlay as click catcher', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toContain('pointer-events:all')
    expect(script).toContain('cursor:crosshair')
    expect(script).toContain('100vw')
    expect(script).toContain('100vh')
  })

  it('arm script sanitizes URLs by stripping query strings', () => {
    const script = buildGuestOverlayScript('arm')
    expect(script).toContain('sanitizeUrl')
    expect(script).toContain("u.search = ''")
    expect(script).toContain("u.hash = ''")
  })

  it('arm script sanitizeUrl returns empty string on parse failure', () => {
    const script = buildGuestOverlayScript('arm')
    // The catch block should return '' not the raw URL
    expect(script).toContain("return '';")
  })

  it('arm script rejects executable and embedded URL schemes', () => {
    const script = buildGuestOverlayScript('arm')

    expect(script).toContain('SAFE_URL_PROTOCOLS')
    expect(script).toContain('!SAFE_URL_PROTOCOLS.has(u.protocol)')
  })

  it('arm script folds bounded text without joining text-node chunks', () => {
    const script = buildGuestOverlayScript('arm')

    expect(script).toContain(
      "appendNormalizedText(acc, (node.nodeValue || '').slice(0, remaining), max)"
    )
    expect(script).toContain('appendNormalizedText(acc, value, BUDGET.selectedTextMaxLength)')
    expect(script).toContain('value = value.slice(start, end)')
    expect(script).not.toContain("chunks.join(' ')")
    expect(script).not.toContain('replace(/\\s+/g')
    expect(script).not.toContain("(el.textContent || '').trim()")
    expect(script).not.toContain('ref.textContent')
  })

  it('arm script walks nearby siblings without materializing sibling arrays', () => {
    const script = buildGuestOverlayScript('arm')

    expect(script).toContain('previousElementSibling')
    expect(script).toContain('nextElementSibling')
    expect(script).not.toContain('Array.from(parent.children)')
  })

  it('arm script tokenizes aria-labelledby without regex splitting', () => {
    const script = buildGuestOverlayScript('arm')

    expect(script).toContain('getAriaLabelledByIds')
    expect(script).toContain('isAriaLabelledBySeparator')
    expect(script).not.toContain('ariaLabelledBy.split(/\\s+/)')
  })
})

// Regression coverage for issue #9947: Zone.js swaps the global Promise for a
// non-native thenable, which executeJavaScript won't unwrap — so a page-global
// `new Promise(...)` crossed as its raw `__zone_symbol__*` wrapper, not { page, target }.
describe('awaitClick under a Zone.js-patched global Promise', () => {
  type Executor<T> = (resolve: (value: T) => void, reject: (reason: unknown) => void) => void

  // Native promises are kept off the instance so its own enumerable keys match
  // Zone.js exactly: ['__zone_symbol__state', '__zone_symbol__value'].
  const nativeOf = new WeakMap<object, Promise<unknown>>()

  /** A non-native thenable that mimics Zone.js's ZoneAwarePromise wrapper. */
  class ZoneAwarePromiseLike<T = unknown> {
    __zone_symbol__state: unknown = null
    __zone_symbol__value: unknown = undefined

    constructor(executor: Executor<T>) {
      nativeOf.set(
        this,
        new Promise<T>((res, rej) => {
          executor(
            (value) => {
              this.__zone_symbol__state = true
              this.__zone_symbol__value = value
              res(value)
            },
            (reason) => {
              this.__zone_symbol__state = false
              this.__zone_symbol__value = reason
              rej(reason)
            }
          )
        })
      )
    }

    // Why: real Zone.js defines `get [Symbol.toStringTag]() { return 'Promise' }`,
    // so an Object.prototype.toString check is fooled into seeing a promise. The
    // boundary below deliberately uses the brand-based V8 check instead, and the
    // control test asserts this tag does NOT let the wrapper masquerade as native.
    get [Symbol.toStringTag](): string {
      return 'Promise'
    }

    // oxlint-disable-next-line unicorn/no-thenable -- intentionally a non-native thenable modeling Zone.js's ZoneAwarePromise
    then(
      onFulfilled?: ((value: unknown) => unknown) | null,
      onRejected?: ((reason: unknown) => unknown) | null
    ): Promise<unknown> {
      const native = nativeOf.get(this) as Promise<unknown>
      return native.then(onFulfilled ?? undefined, onRejected ?? undefined)
    }
  }

  /**
   * Models Electron's boundary: it awaits only genuine V8 promises and
   * serializes anything else — including non-native thenables — by value.
   * `util.types.isPromise` is V8's brand-based IsPromise (what Electron uses):
   * realm-independent and unforgeable, unlike an Object.prototype.toString /
   * Symbol.toStringTag check that a ZoneAwarePromise would defeat.
   */
  async function crossExecuteJavaScriptBoundary(completionValue: unknown): Promise<unknown> {
    if (types.isPromise(completionValue)) {
      return await (completionValue as Promise<unknown>)
    }
    return { ...(completionValue as Record<string, unknown>) }
  }

  const validPayload = (): Record<string, unknown> => ({
    // A minimal but structurally valid payload — page + target are what
    // clampGrabPayload requires and what the bug stripped away.
    page: { title: 'Angular App' },
    target: { tagName: 'button' },
    nearbyText: [],
    ancestorPath: [],
    screenshot: null
  })

  function armGrabHarness(options?: {
    extractPayload?: () => unknown
    getCurrentElement?: () => unknown
  }): {
    window: { __orcaGrab: Record<string, unknown> }
    click: () => void
    contextmenu: () => void
    cancel: () => void
  } {
    const handlers: Record<string, (event: unknown) => void> = {}
    const noopEvent = {
      preventDefault(): void {},
      stopPropagation(): void {},
      stopImmediatePropagation(): void {}
    }
    const grab: Record<string, unknown> = {
      host: {
        addEventListener(type: string, fn: (event: unknown) => void): void {
          handlers[type] = fn
        },
        removeEventListener(): void {}
      },
      extractPayload: options?.extractPayload ?? validPayload,
      getCurrentElement: options?.getCurrentElement ?? ((): unknown => ({})),
      freezeHighlight(): void {},
      cleanup(): void {}
    }
    const window = { __orcaGrab: grab }
    return {
      window,
      click: () => handlers.click?.(noopEvent),
      contextmenu: () => handlers.contextmenu?.(noopEvent),
      // cancelAwait is installed on __orcaGrab by the script itself at runtime.
      cancel: () => (window.__orcaGrab.cancelAwait as (() => void) | undefined)?.()
    }
  }

  const runAwaitClick = (harness: ReturnType<typeof armGrabHarness>): unknown =>
    runInNewContext(buildGuestOverlayScript('awaitClick'), {
      window: harness.window,
      Promise: ZoneAwarePromiseLike,
      Error
    })

  it('returns the payload through a native async promise, not the page-global Promise', () => {
    const script = buildGuestOverlayScript('awaitClick')
    expect(script).toContain('(async function()')
    expect(script).toContain('return await new Promise(')
  })

  it('resolves { page, target } across the boundary despite ZoneAwarePromise', async () => {
    const harness = armGrabHarness()
    const completion = runAwaitClick(harness)

    // The async IIFE hands Electron an intrinsic promise even though the global
    // Promise is a non-native thenable — so the boundary unwraps it.
    expect(types.isPromise(completion)).toBe(true)

    harness.click()
    const received = await crossExecuteJavaScriptBoundary(completion)

    expect(received).toHaveProperty('page')
    expect(received).toHaveProperty('target')
    expect(received).not.toHaveProperty('__zone_symbol__value')
    expect(clampGrabPayload(received)).not.toBeNull()
  })

  it('resolves the context-menu marker across the boundary despite ZoneAwarePromise', async () => {
    const harness = armGrabHarness()
    const completion = runAwaitClick(harness)

    harness.contextmenu()
    const received = (await crossExecuteJavaScriptBoundary(completion)) as Record<string, unknown>

    expect(received).toHaveProperty('__orcaContextMenu', true)
    expect(received.payload).toHaveProperty('page')
    expect(clampGrabPayload(received.payload)).not.toBeNull()
  })

  it('resolves the teardown cancel marker across the boundary despite ZoneAwarePromise', async () => {
    const harness = armGrabHarness()
    const completion = runAwaitClick(harness)

    harness.cancel()
    const received = await crossExecuteJavaScriptBoundary(completion)

    expect(received).toEqual({ __orcaCancelled: true })
  })

  it('rejects across the boundary when selection fails despite ZoneAwarePromise', async () => {
    // getCurrentElement -> null drives onClick's reject(new Error('cancelled')),
    // which must surface as a rejected intrinsic promise (not a serialized value)
    // so the controller classifies it as a cancellation rather than a payload.
    const harness = armGrabHarness({ getCurrentElement: () => null })
    const completion = runAwaitClick(harness)

    harness.click()
    await expect(crossExecuteJavaScriptBoundary(completion)).rejects.toThrow('cancelled')
  })

  it('control: a bare page-global new Promise would cross as the raw wrapper', async () => {
    // Proves the harness detects the regression: without the async wrapper the
    // completion value is the ZoneAwarePromise itself, which the boundary
    // serializes to __zone_symbol__* fields with no page/target.
    const bare = runInNewContext('new Promise(function(r){ r({ page: {}, target: {} }); })', {
      Promise: ZoneAwarePromiseLike
    })
    // Symbol.toStringTag='Promise' fools a toString check — exactly why the
    // boundary must use the brand-based IsPromise, which still rejects it.
    expect(Object.prototype.toString.call(bare)).toBe('[object Promise]')
    expect(types.isPromise(bare)).toBe(false)

    const received = await crossExecuteJavaScriptBoundary(bare)
    expect(received).not.toHaveProperty('page')
    expect(received).toHaveProperty('__zone_symbol__value')
    expect(clampGrabPayload(received)).toBeNull()
  })
})
