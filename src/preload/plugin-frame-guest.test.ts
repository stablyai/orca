import { describe, expect, it, vi } from 'vitest'
import { buildSync } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import {
  PLUGIN_FRAME_IPC_CHANNEL,
  PLUGIN_FRAME_KEY_CHANNEL,
  PLUGIN_FRAME_TRANSPORT_GLOBAL
} from '../shared/plugins/frames/plugin-frame-guest'
import {
  createPluginFrameGestureTracker,
  createPluginFrameSendBudget,
  measurePluginFrameMessageBytes
} from './plugin-frame-guest-send-budget'

type Transport = { send: (message: unknown) => void; subscribe: (fn: (m: unknown) => void) => void }
type Listener = (event: { isTrusted: boolean } & Record<string, unknown>) => void

const preloadSource = buildSync({
  entryPoints: [fileURLToPath(new URL('./plugin-frame-guest.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  write: false
}).outputFiles[0].text

function runPreload(isMainFrame: boolean, contentType = 'text/html') {
  const sendToHost = vi.fn()
  const ipcListeners: ((event: unknown, message: unknown) => void)[] = []
  const domListeners = new Map<string, Listener>()
  const activation = { isActive: false }
  const pageWindow: Record<string, unknown> = {
    addEventListener: (name: string, listener: Listener) => domListeners.set(name, listener)
  }
  runInNewContext(preloadSource, {
    window: pageWindow,
    document: { contentType },
    Object,
    ArrayBuffer,
    Array,
    Date,
    Number,
    String,
    TextEncoder,
    queueMicrotask,
    navigator: { userActivation: activation },
    process: { isMainFrame },
    require: (name: string) => {
      expect(name).toBe('electron')
      return {
        ipcRenderer: {
          sendToHost,
          on: (channel: string, listener: (event: unknown, message: unknown) => void) => {
            expect(channel).toBe(PLUGIN_FRAME_IPC_CHANNEL)
            ipcListeners.push(listener)
          }
        },
        contextBridge: {
          executeInMainWorld: (script: { func: (...args: unknown[]) => void; args: unknown[] }) =>
            script.func(...script.args)
        }
      }
    }
  })
  const input = (name: string, event: { isTrusted: boolean } & Record<string, unknown>) => {
    activation.isActive = activation.isActive || event.isTrusted
    domListeners.get(name)?.(event)
  }
  const transport = (): Transport =>
    Object.getOwnPropertyDescriptor(pageWindow, PLUGIN_FRAME_TRANSPORT_GLOBAL)?.value
  return { sendToHost, ipcListeners, pageWindow, input, transport, activation }
}

describe('plugin frame guest preload', () => {
  it('hands the shell a deletable transport and stamps each send with a gesture serial', () => {
    const { sendToHost, ipcListeners, pageWindow, input, transport } = runPreload(true)
    expect(
      Object.getOwnPropertyDescriptor(pageWindow, PLUGIN_FRAME_TRANSPORT_GLOBAL)
    ).toMatchObject({ configurable: true, enumerable: false, writable: false })
    transport().send({ orca: 1, kind: 'evt', event: 'ready' })
    expect(sendToHost).toHaveBeenLastCalledWith(
      PLUGIN_FRAME_IPC_CHANNEL,
      { orca: 1, kind: 'evt', event: 'ready' },
      { gesture: 0 }
    )
    // Untrusted (page-dispatched) input is not a gesture.
    input('pointerdown', { isTrusted: false })
    transport().send({})
    expect(sendToHost).toHaveBeenLastCalledWith(PLUGIN_FRAME_IPC_CHANNEL, {}, { gesture: 0 })
    input('pointerdown', { isTrusted: true })
    transport().send({})
    expect(sendToHost).toHaveBeenLastCalledWith(PLUGIN_FRAME_IPC_CHANNEL, {}, { gesture: 1 })
    input('keydown', { isTrusted: true, key: 'a', code: 'KeyA' })
    transport().send({})
    expect(sendToHost).toHaveBeenLastCalledWith(PLUGIN_FRAME_IPC_CHANNEL, {}, { gesture: 2 })
    const first = vi.fn()
    transport().subscribe(first)
    transport().subscribe(vi.fn())
    expect(ipcListeners).toHaveLength(1)
    ipcListeners[0]?.({}, { orca: 1, kind: 'res', id: 0 })
    expect(first).toHaveBeenCalledWith({ orca: 1, kind: 'res', id: 0 })
  })

  it('reports trusted modifier chords on their own channel, never page-dispatched ones', () => {
    const { sendToHost, input } = runPreload(true)
    const chord = { key: 's', code: 'KeyS', metaKey: true, ctrlKey: false, altKey: false }
    input('keydown', { isTrusted: false, ...chord, shiftKey: false })
    expect(sendToHost).not.toHaveBeenCalledWith(PLUGIN_FRAME_KEY_CHANNEL, expect.anything())
    input('keydown', { isTrusted: true, ...chord, shiftKey: false, repeat: false })
    expect(sendToHost).toHaveBeenCalledWith(PLUGIN_FRAME_KEY_CHANNEL, { ...chord, shiftKey: false })
  })

  it('answers a refused request at once instead of leaving it pending', async () => {
    const { sendToHost, transport } = runPreload(true)
    const receive = vi.fn()
    transport().subscribe(receive)
    transport().send({
      orca: 1,
      kind: 'req',
      id: 7,
      method: 'notifications.show',
      params: { title: 'x'.repeat(200 * 1024) }
    })
    await Promise.resolve()
    expect(sendToHost).not.toHaveBeenCalled()
    expect(receive).toHaveBeenCalledWith({
      orca: 1,
      kind: 'res',
      id: 7,
      error: expect.objectContaining({ code: 'too_large', retryable: false })
    })
  })

  it('leaves subframes and non-HTML documents without a transport', () => {
    expect(PLUGIN_FRAME_TRANSPORT_GLOBAL in runPreload(false).pageWindow).toBe(false)
    expect(PLUGIN_FRAME_TRANSPORT_GLOBAL in runPreload(true, 'image/svg+xml').pageWindow).toBe(
      false
    )
  })
})

describe('isolated-world send budget', () => {
  it('measures UTF-8 like the host, and keeps big payloads to saves and edits', () => {
    expect(measurePluginFrameMessageBytes('abc', 1000)).toBe(3)
    expect(measurePluginFrameMessageBytes('é', 1000)).toBe(2)
    const admit = createPluginFrameSendBudget()
    const big = 'x'.repeat(30 * 1024 * 1024)
    expect(admit({ kind: 'req', method: 'editor.applyEdit', params: { text: big } })).toBeNull()
    expect(admit({ kind: 'req', method: 'files.saveAs', params: { data: big } })).toBeNull()
    expect(admit({ kind: 'req', method: 'notifications.show', params: { title: big } })).toEqual({
      code: 'too_large'
    })
  })

  it('refuses floods with a retry hint', () => {
    let clock = 0
    const admit = createPluginFrameSendBudget(() => clock, {
      maxMessages: 2,
      maxBytes: 1_000_000,
      perMs: 100
    })
    expect(admit({ a: 1 })).toBeNull()
    clock = 40
    expect(admit({ a: 1 })).toBeNull()
    expect(admit({ a: 1 })).toEqual({ code: 'rate_limited', retryAfterMs: 60 })
    clock = 100
    expect(admit({ a: 1 })).toBeNull()
  })

  it('counts a gesture only for trusted input, and only while activation lasts', () => {
    let clock = 0
    const gestures = createPluginFrameGestureTracker(() => clock)
    gestures.note({ isTrusted: false })
    expect(gestures.current(true)).toBe(0)
    gestures.note({ isTrusted: true })
    expect(gestures.current(true)).toBe(1)
    expect(gestures.current(false)).toBe(0)
    clock = 6_000
    expect(gestures.current(true)).toBe(0)
  })
})

it('delivers an acknowledged one GiB range scan through the actual isolated preload', async () => {
  const { transport, sendToHost, ipcListeners } = runPreload(true)
  let receivedBytes = 0
  let eof = false
  let failure: unknown
  transport().subscribe((message) => {
    if (typeof message !== 'object' || message === null) return
    if ('error' in message) {
      failure = message.error
      return
    }
    if (
      'result' in message &&
      typeof message.result === 'object' &&
      message.result !== null &&
      'bytes' in message.result &&
      message.result.bytes instanceof ArrayBuffer &&
      'eof' in message.result
    ) {
      receivedBytes += message.result.bytes.byteLength
      eof = message.result.eof === true
    }
  })
  const page = new ArrayBuffer(262144)
  sendToHost.mockImplementation((_channel, message: { id: number; params: { offset: number } }) => {
    ipcListeners[0](
      {},
      {
        orca: 1,
        kind: 'res',
        id: message.id,
        result: { version: 1, bytes: page, eof: message.params.offset === 1073479680 }
      }
    )
  })
  for (let offset = 0; offset < 1073741824; offset += 262144) {
    transport().send({
      orca: 1,
      kind: 'req',
      id: offset / 262144,
      method: 'editor.readRange',
      params: { version: 1, offset, length: 262144 }
    })
  }
  await Promise.resolve()
  expect({ receivedBytes, eof, failure }).toEqual({
    receivedBytes: 1073741824,
    eof: true,
    failure: undefined
  })
})

it('keeps unknown and oversized range envelopes in the ordinary control budget', () => {
  const admit = createPluginFrameSendBudget(() => 0, {
    maxMessages: 1,
    maxBytes: 1000000,
    perMs: 100
  })
  const request = {
    orca: 1,
    kind: 'req',
    id: 1,
    method: 'editor.readRange',
    params: { version: 1, offset: 0, length: 1 }
  }
  expect(admit({ orca: 1, kind: 'evt', event: 'control' })).toBeNull()
  expect(admit({ ...request, junk: new Map([['hidden', new ArrayBuffer(2048)]]) })).toMatchObject({
    code: 'rate_limited'
  })
  expect(
    admit({ ...request, params: { ...request.params, path: '/not-authorized' } })
  ).toMatchObject({ code: 'rate_limited' })
  expect(admit({ ...request, junk: new ArrayBuffer(1024 * 1024) })).toEqual({ code: 'too_large' })
})
