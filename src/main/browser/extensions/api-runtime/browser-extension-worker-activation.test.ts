import type { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(
  (): {
    windows: { webContents: EventEmitter; finish: () => void; started: Promise<void> }[]
    start: () => Promise<unknown>
  } => ({
    windows: [],
    start: async () => worker
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
              resolve({ challenge, token: execution.workerToken, connectionId: 'fixture' })
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
vi.mock('./browser-extension-worker-start', () => ({
  startBrowserExtensionWorker: () => native.start()
}))
import { ensureHostSessionState } from './browser-extension-contexts'
import {
  beginBrowserExtensionExecution,
  retireBrowserExtensionExecution,
  type BrowserExtensionExecution
} from './browser-extension-execution-authority'
import { activateBrowserExtensionWorker } from './browser-extension-worker-activation'

let execution: BrowserExtensionExecution
const worker = { versionId: 7 }
function start() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The owned fixture supplies the session identity and lifecycle methods accessed by this production path.
  const session = {
    serviceWorkers: { getAllRunning: () => ({ 7: {} }) }
  } as unknown as Electron.Session
  const host = ensureHostSessionState(session, 'activation')
  execution = beginBrowserExtensionExecution(session, 'a'.repeat(32), new AbortController().signal)
  host.workers.set(execution.extensionId, {
    extensionId: execution.extensionId,
    scope: `chrome-extension://${execution.extensionId}/`,
    events: new Set(),
    filters: new Map(),
    queue: [],
    starting: false,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the activation fixture delegates scope start to this worker identity and never calls its native methods.
    running: worker as Electron.ServiceWorkerMain,
    run: new AbortController(),
    stream: {
      connectionId: 'fixture',
      controller: new AbortController(),
      events: new Set(),
      filters: new Map(),
      published: true,
      send: () => {},
      close: () => {}
    }
  })
  return activateBrowserExtensionWorker(execution)
}

afterEach(async () => {
  await retireBrowserExtensionExecution(execution.session, execution.extensionId)
  native.windows.splice(0)
  vi.useRealTimers()
  native.start = async () => worker
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
  await vi.waitFor(() => expect(native.windows.length).toBe(1))
  native.windows.at(-1)!.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  await rejected
})

it('fails a native start before creating a receiver and leaves extension execution usable', async () => {
  native.start = async () => {
    throw new Error('Failed to start service worker')
  }
  await expect(start()).rejects.toThrow('Failed to start service worker')
  expect(execution.controller.signal.aborted).toBe(false)
  expect(native.windows).toHaveLength(0)
})

it('fails missing proof within the request budget without retiring the loaded execution', async () => {
  vi.useFakeTimers()
  const ready = start()
  const rejected = expect(ready).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(300_000)
  await rejected
  expect(execution.controller.signal.aborted).toBe(false)
})

it.each([10, 100])(
  'shares one unresolved native proof for %i callers and starts a fresh later proof',
  async (count) => {
    const first = start()
    const ready = Promise.all([
      first,
      ...Array.from({ length: count - 1 }, () => activateBrowserExtensionWorker(execution))
    ])
    await vi.waitFor(() => expect(native.windows.length).toBe(1))
    await native.windows[0].started
    expect(native.windows).toHaveLength(1)
    native.windows[0].finish()
    await ready
    const next = activateBrowserExtensionWorker(execution)
    await vi.waitFor(() => expect(native.windows.length).toBe(2))
    await native.windows[1].started
    expect(native.windows).toHaveLength(2)
    native.windows[1].finish()
    await next
  }
)
