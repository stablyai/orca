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
      rollupOptions: {
        input: {
          guest: resolve(import.meta.dirname, 'browser-window-close.ts'),
          shared: resolve(import.meta.dirname, '../shared/browser-history-gesture.ts')
        },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  })
  if (Array.isArray(result) || !('output' in result)) {
    throw new Error('Expected a single completed build')
  }
  const entry = result.output.find((file) => file.type === 'chunk' && file.name === 'guest')
  if (!entry || entry.type !== 'chunk') {
    throw new Error('Missing guest preload')
  }
  const ipc = new EventEmitter()
  const reports: unknown[][] = []
  const closeRequests: unknown[][] = []
  const listeners = new Map<string, (event: object) => void>()
  const window = {
    close: () => {},
    addEventListener: (type: string, callback: (event: object) => void) =>
      listeners.set(type, callback),
    setTimeout: (callback: () => void) => callback()
  }
  runInNewContext(
    entry.code,
    {
      process: { platform: 'darwin', isMainFrame: true },
      window,
      WheelEvent: { DOM_DELTA_PIXEL: 0 },
      require: (module: string) => {
        if (module !== 'electron') {
          throw new Error(`Sandbox cannot load ${module}`)
        }
        return {
          contextBridge: {
            executeInMainWorld: ({
              func,
              args
            }: {
              func: (requestClose: () => void) => void
              args: [() => void]
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
  window.close()
  expect(closeRequests).toEqual([['orca:guest-window-close']])
  ipc.emit('browser:history-gesture', {}, 7)
  listeners.get('wheel')?.({
    isTrusted: true,
    deltaMode: 0,
    deltaX: -120,
    deltaY: 0,
    defaultPrevented: false,
    composedPath: () => []
  })
  expect(reports).toEqual([
    ['browser:history-wheel', { gestureId: 7, deltaX: -120, deltaY: 0, blocked: false }]
  ])
})
