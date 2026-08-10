/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest'

import {
  installHappyDomMutationObserverRetention,
  retainedMutationCallbackCount
} from './happy-dom-mutation-observer-retention'

function readListenerCallbacks(target: Node): unknown[] {
  const listenersSymbol = Object.getOwnPropertySymbols(target).find(
    (candidate) => candidate.description === 'mutationListeners'
  )
  const listeners = listenersSymbol
    ? (target as unknown as Record<symbol, unknown>)[listenersSymbol]
    : []
  if (!Array.isArray(listeners)) {
    return []
  }
  return listeners.map((listener: { callback?: { deref: () => unknown } }) =>
    listener.callback?.deref()
  )
}

describe('happy-dom MutationObserver retention', () => {
  it('pins the internal callback that happy-dom only holds weakly', () => {
    expect(installHappyDomMutationObserverRetention()).toBe(true)
    const target = document.createElement('div')
    document.body.append(target)
    const observer = new MutationObserver(() => {})
    observer.observe(target, { childList: true, subtree: true })

    const callbacks = readListenerCallbacks(target)
    expect(callbacks.length).toBe(1)
    expect(callbacks[0]).toBeTypeOf('function')
    expect(retainedMutationCallbackCount(observer)).toBe(1)

    observer.disconnect()
    expect(retainedMutationCallbackCount(observer)).toBe(0)
    target.remove()
  })

  it('keeps delivering records after the weak callback would have been collected', async () => {
    installHappyDomMutationObserverRetention()
    const target = document.createElement('div')
    document.body.append(target)
    let deliveries = 0
    const observer = new MutationObserver(() => {
      deliveries += 1
    })
    observer.observe(target, { childList: true, subtree: true })

    target.replaceChildren(document.createElement('div'))
    await Promise.resolve()
    expect(deliveries).toBe(1)

    const collectGarbage = (globalThis as { gc?: () => void }).gc
    if (collectGarbage) {
      for (let round = 0; round < 5; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1))
        collectGarbage()
      }
      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    target.replaceChildren(document.createElement('span'))
    await Promise.resolve()
    expect(deliveries).toBe(2)

    observer.disconnect()
    target.remove()
  })
})
