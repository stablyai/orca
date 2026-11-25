import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { build } from 'vite'
import { expect, it } from 'vitest'

it('preserves close requests and gestures in the standalone sandboxed preload', async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: resolve(import.meta.dirname, 'browser-guest.ts'),
        formats: ['cjs'],
        fileName: 'browser-guest'
      },
      rollupOptions: { external: ['electron'] }
    }
  })
  const output = Array.isArray(result) ? result[0] : result
  if (!output || !('output' in output)) {
    throw new Error('Expected a single completed build')
  }
  const entry = output.output.find((file) => file.type === 'chunk' && file.isEntry)
  if (!entry || entry.type !== 'chunk') {
    throw new Error('Missing guest preload')
  }
  const { ipc, window, closeRequests, reports, listeners } = loadGuest(entry.code, true)
  window.close()
  expect(closeRequests).toEqual([['orca:guest-window-close']])

  const subframe = loadGuest(entry.code, false)
  subframe.window.close()
  expect(subframe.closeRequests).toEqual([])
  expect(subframe.listeners.has('wheel')).toBe(false)

  ipc.emit('browser:history-gesture', {}, 7)
  listeners.get('wheel')?.({
    isTrusted: true,
    deltaMode: 0,
    deltaX: -120,
    deltaY: 0,
    defaultPrevented: false,
    composedPath: () => []
  })
  expect(reports.filter(([channel]) => channel === 'browser:history-wheel')).toEqual([
    ['browser:history-wheel', { gestureId: 7, deltaX: -120, deltaY: 0, blocked: false }]
  ])
})

type GuestWheelEvent = Pick<
  WheelEvent,
  'isTrusted' | 'deltaMode' | 'deltaX' | 'deltaY' | 'defaultPrevented' | 'composedPath'
>

function loadGuest(code: string, isMainFrame: boolean) {
  const ipc = new EventEmitter()
  const reports: unknown[][] = []
  const closeRequests: unknown[][] = []
  const listeners = new Map<string, (event: GuestWheelEvent) => void>()
  const window = {
    close: () => {},
    addEventListener: (type: string, callback: (event: GuestWheelEvent) => void) =>
      listeners.set(type, callback),
    setTimeout: (callback: () => void) => callback()
  }
  runInNewContext(
    code,
    {
      process: { platform: 'darwin', isMainFrame },
      window: Object.assign(window, { top: isMainFrame ? window : {} }),
      document: { addEventListener: () => {} },
      EventTarget,
      WheelEvent: { DOM_DELTA_PIXEL: 0 },
      require: (name: string) => {
        if (name !== 'electron') {
          throw new Error(`Sandbox cannot load ${name}`)
        }
        return {
          contextBridge: {
            executeInMainWorld: ({
              func,
              args
            }: {
              func: (...args: unknown[]) => void
              args: unknown[]
            }) => func(...args)
          },
          ipcRenderer: Object.assign(ipc, {
            send: (...args: unknown[]) => reports.push(args),
            sendToHost: (...args: unknown[]) => closeRequests.push(args)
          })
        }
      }
    },
    { timeout: 1000 }
  )
  return { ipc, window, closeRequests, reports, listeners }
}
