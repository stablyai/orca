import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { whenBrowserExtensionsInSession } from './browser-extension-session-presence'
import { loadPageWhenReady } from './browser-page-held-first-load'

class FakePage extends EventEmitter {
  readonly started: string[] = []
  destroyed = false
  loadURL(url: string): Promise<void> {
    this.started.push(url)
    return Promise.resolve()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

function hold(page: FakePage, ready: Promise<void>): Promise<void> {
  const contents = page as unknown as Electron.WebContents
  return loadPageWhenReady(contents, ready, (requested) =>
    contents.loadURL(requested?.url ?? 'https://saved.test/')
  )
}

describe('a held first load', () => {
  it('starts nothing until ready, then only the newest load asked for meanwhile', async () => {
    const page = new FakePage()
    const ready = deferred()
    const held = hold(page, ready.promise)
    const older = page.loadURL('https://a.test/')
    const newest = page.loadURL('https://b.test/')
    await expect(older).rejects.toMatchObject({ errno: -3 })
    expect(page.started).toEqual([])

    ready.resolve()
    await held
    await newest
    expect(page.started).toEqual(['https://b.test/'])
  })

  it('ends when the page closes, settling its queued load and loading nothing', async () => {
    const page = new FakePage()
    const ready = deferred()
    const held = hold(page, ready.promise)
    const queued = page.loadURL('https://a.test/')
    page.destroyed = true
    page.emit('destroyed')
    await expect(queued).rejects.toThrow('closed')
    await expect(held).rejects.toThrow('closed')
    ready.resolve()
    await Promise.resolve()
    expect(page.started).toEqual([])
  })
})

describe('extensions in the session', () => {
  it('waits for every startup extension to load, or for its load to end', async () => {
    const extensions = Object.assign(new EventEmitter(), { getExtension: () => null })
    const sess = { extensions } as unknown as Electron.Session
    const loadEnded = deferred()
    let inSession = false
    void whenBrowserExtensionsInSession(sess, ['one', 'two'], loadEnded.promise).then(
      () => (inSession = true)
    )
    extensions.emit('extension-loaded', {}, { id: 'one' })
    await Promise.resolve()
    expect(inSession).toBe(false)
    extensions.emit('extension-loaded', {}, { id: 'two' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(inSession).toBe(true)
    expect(extensions.listenerCount('extension-loaded')).toBe(0)
  })
})
