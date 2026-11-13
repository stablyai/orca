import { types } from 'node:util'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { buildGuestOverlayScript } from './grab-guest-script'
import { clampGrabPayload } from './browser-grab-payload'

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
    const grab: Record<string, unknown> = {
      extractPayload: options?.extractPayload ?? validPayload,
      getCurrentElement: options?.getCurrentElement ?? ((): unknown => ({})),
      freezeHighlight(): void {},
      cleanup(): void {}
    }
    const window = { __orcaGrab: grab }
    // The overlay hands each real pointer pick to the awaiting script.
    const pick = (type: string): void => {
      const onPick = grab.onPick
      if (typeof onPick === 'function') {
        onPick({ type })
      }
    }
    return {
      window,
      click: () => pick('click'),
      contextmenu: () => pick('contextmenu'),
      cancel: () => (window.__orcaGrab.cancelAwait as (() => void) | undefined)?.()
    }
  }

  const runAwaitClick = (harness: ReturnType<typeof armGrabHarness>): unknown =>
    runInNewContext(buildGuestOverlayScript('awaitClick'), {
      window: harness.window,
      Promise: ZoneAwarePromiseLike,
      Error
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
})
