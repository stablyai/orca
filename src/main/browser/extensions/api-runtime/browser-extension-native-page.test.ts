import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { ensureHostSessionState, forgetHostSession } from './browser-extension-contexts'
import {
  beginBrowserExtensionExecution,
  retireBrowserExtensionExecution
} from './browser-extension-execution-authority'

const native = vi.hoisted(() => ({ createWindow: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor() {
      return native.createWindow()
    }
  }
}))

const { BrowserExtensionNativePage } = await import('./browser-extension-native-page')

it.each([100, 1000])(
  'releases completed-call destruction ownership after %i successful calls and fences pending failure',
  async (count) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the session identity is used by this execution fixture.
    const session = {} as Electron.Session
    ensureHostSessionState(session, 'native-page')
    const execution = beginBrowserExtensionExecution(session, 'vault', new AbortController().signal)
    const executing = Promise.withResolvers<void>()
    const closing = Promise.withResolvers<void>()
    let pending = 0
    let destroyed = false
    const contents = Object.assign(new EventEmitter(), {
      isDestroyed: () => destroyed,
      executeJavaScript: async (code: string): Promise<unknown> => {
        if (code === 'hold') {
          if (++pending === 2) {
            executing.resolve()
          }
          return new Promise<never>(() => {})
        }
        return 42
      }
    })
    native.createWindow.mockReturnValue({
      webContents: contents,
      loadURL: async () => undefined,
      destroy: () => closing.resolve()
    })
    const page = new BrowserExtensionNativePage(execution)
    const lifetime = [...execution.operations][0]
    if (!lifetime) {
      throw new Error('Native page has no teardown fence')
    }
    // Count reactions on the real pending teardown promise: a listener-only check misses the leak.
    const reactions = vi.spyOn(lifetime, 'then')
    try {
      for (let index = 0; index < count; index++) {
        expect(await page.run('42')).toBe(42)
      }
      expect(contents.listenerCount('destroyed')).toBe(1)
      expect(reactions.mock.calls).toHaveLength(0)
      reactions.mockRestore()

      let released = false
      execution.release = async () => {
        expect(destroyed).toBe(true)
        released = true
      }
      const caller = new AbortController()
      let failurePublished = false
      const results = Promise.allSettled(
        [page.run('hold', undefined, caller.signal), page.run('hold')].map((operation) =>
          operation.catch((error: unknown) => {
            failurePublished = true
            expect(destroyed).toBe(true)
            throw error
          })
        )
      )
      await executing.promise
      caller.abort()
      await closing.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(failurePublished).toBe(false)
      destroyed = true
      contents.emit('destroyed')
      expect(await results).toEqual([
        { status: 'rejected', reason: new Error('Extension context was unloaded') },
        { status: 'rejected', reason: new Error('Extension context was unloaded') }
      ])
      await retireBrowserExtensionExecution(session, 'vault')
      expect(released).toBe(true)
      expect(contents.listenerCount('destroyed')).toBe(0)
    } finally {
      reactions.mockRestore()
      if (!destroyed) {
        destroyed = true
        contents.emit('destroyed')
      }
      await retireBrowserExtensionExecution(session, 'vault')
      forgetHostSession(session)
    }
  }
)
