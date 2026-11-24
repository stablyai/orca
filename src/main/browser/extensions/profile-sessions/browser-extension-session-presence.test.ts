import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  noteBrowserExtensionLoadEnded,
  noteBrowserExtensionsStarting,
  whenBrowserExtensionsInSession
} from './browser-extension-session-presence'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

type FakeExtensions = EventEmitter & { getExtension: (id: string) => { id: string } | null }

function fakeSession(): { sess: Electron.Session; extensions: FakeExtensions } {
  const extensions: FakeExtensions = Object.assign(new EventEmitter(), {
    getExtension: (_id: string): { id: string } | null => null
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the presence wait reads only session.extensions events and getExtension.
  return { sess: { extensions } as unknown as Electron.Session, extensions }
}

describe('extensions in the session', () => {
  it('waits for every startup extension to load', async () => {
    const { sess, extensions } = fakeSession()
    let inSession = false
    noteBrowserExtensionsStarting(sess, ['one', 'two'])
    void whenBrowserExtensionsInSession(sess, deferred().promise).then(() => (inSession = true))
    expect(extensions.listenerCount('extension-loaded')).toBe(1)
    extensions.emit('extension-loaded', {}, { id: 'one' })
    await settle()
    expect(inSession).toBe(false)
    extensions.emit('extension-loaded', {}, { id: 'two' })
    await settle()
    expect(inSession).toBe(true)
    expect(extensions.listenerCount('extension-loaded')).toBe(0)
  })

  it('stops waiting for an extension whose load failed', async () => {
    const { sess, extensions } = fakeSession()
    let inSession = false
    noteBrowserExtensionsStarting(sess, ['good', 'broken'])
    void whenBrowserExtensionsInSession(sess, deferred().promise).then(() => (inSession = true))
    extensions.emit('extension-loaded', {}, { id: 'good' })
    await settle()
    expect(inSession).toBe(false)
    noteBrowserExtensionLoadEnded(sess, 'broken')
    await settle()
    expect(inSession).toBe(true)
    expect(extensions.listenerCount('extension-loaded')).toBe(0)
    extensions.getExtension = (id: string) => (id === 'good' ? { id } : null)
    let laterInSession = false
    void whenBrowserExtensionsInSession(sess, deferred().promise).then(
      () => (laterInSession = true)
    )
    await settle()
    expect(laterInSession).toBe(true)
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
