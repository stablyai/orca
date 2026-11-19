import { describe, expect, it, vi } from 'vitest'
import { buildSync } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import {
  PLUGIN_FRAME_IPC_CHANNEL,
  PLUGIN_FRAME_TRANSPORT_GLOBAL
} from '../../../shared/plugins/frames/plugin-frame-guest'
import {
  createPluginFrameGestureTracker,
  createPluginFrameSendBudget,
  measurePluginFrameMessageBytes
} from './plugin-frame-guest-send-budget'

type Transport = { send: (message: unknown) => void; subscribe: (fn: (m: unknown) => void) => void }
type Listener = (event: { isTrusted: boolean } & Record<string, unknown>) => void

const preloadSource = buildSync({
  entryPoints: [fileURLToPath(new URL('../../plugin-frame-guest.ts', import.meta.url))],
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
