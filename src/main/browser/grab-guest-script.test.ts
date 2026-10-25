import { createHash } from 'node:crypto'
import { types } from 'node:util'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { buildGuestOverlayScript } from './grab-guest-script'
import { clampGrabPayload } from './browser-grab-payload'

describe('buildGuestOverlayScript', () => {
  it.each([
    ['arm', 'a721de2fc19173f5742f27a914019c5c0d5ea727f211369e22d5743bbb56c37e'],
    ['awaitClick', '4e7c30a9382cd18bf6286fbdbdfa70f7571cdddfc4914a9d9ffd4f9b0e430adb'],
    ['finalize', '91bd9836b0536c9579e0d4648d30679c0b4a5893d9a43110a70e67d6804fd291'],
    ['extractHover', 'cf0ee3ac61669daefa7db9389233c1abfe9f0fb9e7257300c761987aac914b02'],
    ['teardown', 'b794f7e6baadefdce1b34f4a68d744a765e5519312b228fae57628cf34a9a152']
  ] as const)('preserves the serialized %s guest script', (action, expectedSha256) => {
    expect(createHash('sha256').update(buildGuestOverlayScript(action)).digest('hex')).toBe(
      expectedSha256
    )
  })

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

describe('awaitClick under a Zone.js-patched global Promise', () => {
  type Executor<T> = (resolve: (value: T) => void, reject: (reason: unknown) => void) => void

  // Keep native promises off-instance to match Zone.js's enumerable wrapper fields.
  const nativeOf = new WeakMap<object, Promise<unknown>>()

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

    // Zone.js spoofs the Promise tag; the boundary must use V8's brand check.
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

  /** Electron unwraps genuine V8 promises and serializes other thenables by value. */
  async function crossExecuteJavaScriptBoundary(completionValue: unknown): Promise<unknown> {
    if (types.isPromise(completionValue)) {
      return await (completionValue as Promise<unknown>)
    }
    return { ...(completionValue as Record<string, unknown>) }
  }

  const validPayload = (): Record<string, unknown> => ({
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
    const harness = armGrabHarness({ getCurrentElement: () => null })
    const completion = runAwaitClick(harness)

    harness.click()
    await expect(crossExecuteJavaScriptBoundary(completion)).rejects.toThrow('cancelled')
  })

  it('control: a bare page-global new Promise would cross as the raw wrapper', async () => {
    const bare = runInNewContext('new Promise(function(r){ r({ page: {}, target: {} }); })', {
      Promise: ZoneAwarePromiseLike
    })
    expect(Object.prototype.toString.call(bare)).toBe('[object Promise]')
    expect(types.isPromise(bare)).toBe(false)

    const received = await crossExecuteJavaScriptBoundary(bare)
    expect(received).not.toHaveProperty('page')
    expect(received).toHaveProperty('__zone_symbol__value')
    expect(clampGrabPayload(received)).toBeNull()
  })
})
