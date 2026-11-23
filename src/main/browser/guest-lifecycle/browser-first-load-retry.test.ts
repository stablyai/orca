import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { retryFirstLoadIfStalled } from './browser-first-load-retry'

class FakePage extends EventEmitter {
  destroyed = false
  isDestroyed(): boolean {
    return this.destroyed
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function retrying(page: FakePage): { loads: () => number; ready: () => Promise<void> } {
  const ready = deferred()
  let loads = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the retry reads only once/off and isDestroyed, which FakePage provides.
  retryFirstLoadIfStalled(page as unknown as Electron.WebContents, ready.promise, () => {
    loads++
    return Promise.resolve()
  })
  return {
    loads: () => loads,
    ready: async () => {
      ready.resolve()
      await settle()
    }
  }
}

describe('a first load that may have stalled while extensions loaded', () => {
  it('loads once more when the extensions are ready and it never committed', async () => {
    const page = new FakePage()
    const retry = retrying(page)
    await retry.ready()
    expect(retry.loads()).toBe(1)
    page.emit('did-navigate')
    await settle()
    expect(retry.loads()).toBe(1)
    expect(page.listenerCount('did-navigate')).toBe(0)
  })

  it('does not load again once it committed, or after the page closed', async () => {
    const committed = new FakePage()
    const afterCommit = retrying(committed)
    committed.emit('did-navigate')
    await afterCommit.ready()
    expect(afterCommit.loads()).toBe(0)

    const closed = new FakePage()
    const afterClose = retrying(closed)
    closed.destroyed = true
    await afterClose.ready()
    expect(afterClose.loads()).toBe(0)
  })
})
