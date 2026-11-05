import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSync } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

import { installBrowserWindowCloseGuard } from './browser-window-close-installation'
import { BROWSER_GUEST_WINDOW_CLOSE_CHANNEL } from '../shared/browser-guest-window-close'

describe('browser window close guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('replaces the native close with a non-replaceable request to Orca', () => {
    const nativeClose = vi.fn()
    const requestClose = vi.fn()
    vi.stubGlobal('window', { close: nativeClose })

    installBrowserWindowCloseGuard(requestClose)

    expect(window.close()).toBeUndefined()
    expect(nativeClose).not.toHaveBeenCalled()
    expect(requestClose).toHaveBeenCalledTimes(1)
    expect(Reflect.set(window, 'close', nativeClose)).toBe(false)
  })

  it.each([true, false])('routes a close only from the top frame: %s', (isMainFrame) => {
    const sendToHost = vi.fn()
    const nativeClose = vi.fn()
    const pageWindow = { close: nativeClose }
    const preload = buildSync({
      entryPoints: [fileURLToPath(new URL('./browser-guest.ts', import.meta.url))],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      write: false
    }).outputFiles[0].text

    runInNewContext(preload, {
      window: pageWindow,
      process: { isMainFrame },
      require: (name: string) => {
        expect(name).toBe('electron')
        return {
          ipcRenderer: { sendToHost },
          contextBridge: {
            executeInMainWorld: (script: {
              func: (requestClose: () => void) => void
              args: [() => void]
            }) => script.func(...script.args)
          }
        }
      }
    })

    pageWindow.close()

    expect(nativeClose).toHaveBeenCalledTimes(isMainFrame ? 0 : 1)
    expect(sendToHost.mock.calls).toEqual(isMainFrame ? [[BROWSER_GUEST_WINDOW_CLOSE_CHANNEL]] : [])
  })
})
