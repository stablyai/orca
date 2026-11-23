import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { retryFirstLoadIfStalled } from './browser-first-load-retry'

const extensions = new EventEmitter()

class FakePage extends EventEmitter {
  destroyed = false
  readonly session = { extensions }
  isDestroyed(): boolean {
    return this.destroyed
  }
  startNavigation(): void {
    this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function retrying(page: FakePage, ready: { promise: Promise<void> }): () => number {
  let loads = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the retry uses only on/off/once, isDestroyed and session.extensions, which FakePage provides.
  retryFirstLoadIfStalled(page as unknown as Electron.WebContents, ready.promise, () => {
    loads++
    return Promise.resolve()
  })
  page.startNavigation()
  return () => loads
}

describe('a restored first load that may have stalled while extensions loaded', () => {
  it('loads once more only if an extension loaded while it was in flight', async () => {
    const ready = deferred()
    const crossed = new FakePage()
    const loadsCrossed = retrying(crossed, ready)
    extensions.emit('extension-loaded')
    const after = new FakePage()
    const loadsAfter = retrying(after, ready)
    ready.resolve()
    await settle()
    expect([loadsCrossed(), loadsAfter()]).toEqual([1, 0])
    expect(crossed.listenerCount('did-start-navigation')).toBe(0)
    expect(extensions.listenerCount('extension-loaded')).toBe(0)
  })

  it('does not load again after a commit, a Stop, a newer navigation or a close', async () => {
    const ready = deferred()
    const pages = [new FakePage(), new FakePage(), new FakePage(), new FakePage()]
    const loads = pages.map((page) => retrying(page, ready))
    extensions.emit('extension-loaded')
    const [committed, stopped, superseded, closed] = pages
    committed.emit('did-navigate')
    stopped.emit('did-stop-loading')
    superseded.startNavigation()
    closed.destroyed = true
    closed.emit('destroyed')
    expect(closed.listenerCount('did-start-navigation')).toBe(0)
    ready.resolve()
    await settle()
    expect(loads.map((count) => count())).toEqual([0, 0, 0, 0])
  })
})
