import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { retryFirstLoadIfStalled } from './browser-first-load-retry'

class FakePage extends EventEmitter {
  destroyed = false
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

function retrying(
  page: FakePage,
  ready = deferred()
): { loads: () => number; ready: () => Promise<void> } {
  let loads = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the retry uses only on/off/once and isDestroyed, which FakePage provides.
  retryFirstLoadIfStalled(page as unknown as Electron.WebContents, ready.promise, () => {
    loads++
    return Promise.resolve()
  })
  page.startNavigation()
  return {
    loads: () => loads,
    ready: async () => {
      ready.resolve()
      await settle()
    }
  }
}

describe('a first load that may have stalled while extensions loaded', () => {
  it('loads once more when the extensions are ready, if it neither committed nor stopped', async () => {
    const page = new FakePage()
    const retry = retrying(page)
    await retry.ready()
    expect(retry.loads()).toBe(1)
    expect(page.listenerCount('did-start-navigation')).toBe(0)
  })

  it('does not load again after a commit, a Stop, a newer navigation or a close', async () => {
    const ready = deferred()
    const committed = new FakePage()
    const stopped = new FakePage()
    const superseded = new FakePage()
    const closed = new FakePage()
    const retries = [committed, stopped, superseded, closed].map((page) => retrying(page, ready))
    committed.emit('did-navigate')
    stopped.emit('did-stop-loading')
    superseded.startNavigation()
    closed.destroyed = true
    closed.emit('destroyed')
    expect(closed.listenerCount('did-start-navigation')).toBe(0)
    ready.resolve()
    await settle()
    expect(retries.map((retry) => retry.loads())).toEqual([0, 0, 0, 0])
  })
})
