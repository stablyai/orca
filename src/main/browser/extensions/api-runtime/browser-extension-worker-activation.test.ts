import type { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(
  (): { windows: { webContents: EventEmitter; finish: () => void; started: Promise<void> }[] } => ({
    windows: []
  })
)
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  return {
    BrowserWindow: class {
      destroyed = false
      markStarted: () => void = () => {}
      webContents = Object.assign(new Emitter(), {
        isDestroyed: () => this.destroyed,
        executeJavaScript: (code: string) =>
          new Promise((resolve) => {
            const challenge = code.match(/orcaExecutionActivation:"([a-f0-9]+)"/)![1]
            native.windows.at(-1)!.finish = () =>
              resolve({ challenge, token: execution.workerToken })
            this.markStarted()
          })
      })
      constructor() {
        native.windows.push({
          webContents: this.webContents,
          finish: () => {},
          started: new Promise<void>((resolve) => {
            this.markStarted = resolve
          })
        })
      }
      loadURL = async () => {}
      destroy = () => {
        this.destroyed = true
        this.webContents.emit('destroyed')
      }
    }
  }
})
import { ensureHostSessionState } from './browser-extension-contexts'
import {
  beginBrowserExtensionExecution,
  retireBrowserExtensionExecution,
  type BrowserExtensionExecution
} from './browser-extension-execution-authority'
import { activateBrowserExtensionWorker } from './browser-extension-worker-activation'

let execution: BrowserExtensionExecution
function start() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned fixture supplies the session identity and lifecycle methods accessed by this production path.
  const session = {} as Electron.Session
  ensureHostSessionState(session, 'activation')
  execution = beginBrowserExtensionExecution(session, 'a'.repeat(32), new AbortController().signal)
  return activateBrowserExtensionWorker(execution)
}

afterEach(async () => {
  await retireBrowserExtensionExecution(execution.session, execution.extensionId)
  native.windows.splice(0)
  vi.useRealTimers()
})

it('accepts a current valid native ACK beyond the removed short cutoff', async () => {
  vi.useFakeTimers()
  let settled = false
  const ready = start()
  void ready.then(() => {
    settled = true
  })
  await vi.advanceTimersByTimeAsync(3000)
  expect(settled).toBe(false)
  native.windows.at(-1)!.finish()
  await ready
  expect(settled).toBe(true)
})

it('terminates a crashed native receiver without treating it as a valid ACK', async () => {
  const ready = start()
  const rejected = expect(ready).rejects.toThrow('unloaded')
  await Promise.resolve()
  native.windows.at(-1)!.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  await rejected
})

it.each([10, 100])(
  'shares one unresolved native proof for %i callers and starts a fresh later proof',
  async (count) => {
    const first = start()
    const ready = Promise.all([
      first,
      ...Array.from({ length: count - 1 }, () => activateBrowserExtensionWorker(execution))
    ])
    await native.windows[0].started
    expect(native.windows).toHaveLength(1)
    native.windows[0].finish()
    await ready
    const next = activateBrowserExtensionWorker(execution)
    await native.windows[1].started
    expect(native.windows).toHaveLength(2)
    native.windows[1].finish()
    await next
  }
)
