import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  noteBrowserExtensionsStarting,
  whenBrowserExtensionsInSession
} from './browser-extension-session-presence'
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the held load uses only loadURL, on/off/once and isDestroyed, which FakePage provides.
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

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function fakeSession(): { sess: Electron.Session; extensions: EventEmitter } {
  const extensions = Object.assign(new EventEmitter(), { getExtension: () => null })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the presence wait reads only session.extensions events and getExtension.
  return { sess: { extensions } as unknown as Electron.Session, extensions }
}

describe('extensions in the session', () => {
  it('waits for every startup extension to load', async () => {
    const { sess, extensions } = fakeSession()
    let inSession = false
    noteBrowserExtensionsStarting(sess, ['one', 'two'])
    void whenBrowserExtensionsInSession(sess, deferred().promise).then(() => (inSession = true))
    extensions.emit('extension-loaded', {}, { id: 'one' })
    await settle()
    expect(inSession).toBe(false)
    extensions.emit('extension-loaded', {}, { id: 'two' })
    await settle()
    expect(inSession).toBe(true)
    expect(extensions.listenerCount('extension-loaded')).toBe(0)
  })

  it('ends when the startup load ends, though an extension never loaded', async () => {
    const { sess, extensions } = fakeSession()
    const loadEnded = deferred()
    let inSession = false
    noteBrowserExtensionsStarting(sess, ['broken'])
    void whenBrowserExtensionsInSession(sess, loadEnded.promise).then(() => (inSession = true))
    await settle()
    expect(inSession).toBe(false)
    loadEnded.resolve()
    await settle()
    expect(inSession).toBe(true)
    expect(extensions.listenerCount('extension-loaded')).toBe(0)
  })
})
