import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { installBrowserGuestMainWorld } from './browser-guest-main-world-installation'

describe('installBrowserGuestMainWorld', () => {
  it('installs the close guard and anti-detection before page scripts', () => {
    const executeInMainWorld = vi.fn()

    installBrowserGuestMainWorld({ executeInMainWorld } as never)

    expect(executeInMainWorld.mock.calls.map(([script]) => script.func.name)).toEqual([
      'installBrowserWindowCloseGuard',
      'installBrowserAntiDetection'
    ])
  })

  it('installs the Chrome-shaped surface through the preload function', () => {
    class Permissions {
      query(): Promise<{ state: string; onchange: null }> {
        return Promise.resolve({ state: 'denied', onchange: null })
      }
    }
    const executeInMainWorld = vi.fn()
    installBrowserGuestMainWorld({ executeInMainWorld } as never)
    const installAntiDetection = executeInMainWorld.mock.calls[1]?.[0].func as () => void
    const context = {
      Date,
      Object,
      Promise,
      Set,
      performance: { now: () => 0 },
      window: { chrome: {} },
      navigator: {
        userAgent: 'Mozilla/5.0 Chrome/151.0.0.0',
        webdriver: true,
        plugins: [],
        languages: [],
        permissions: new Permissions()
      },
      Notification: {
        permission: 'denied',
        requestPermission: () => Promise.resolve('denied')
      }
    }

    runInNewContext(`(${installAntiDetection.toString()})()`, context)

    expect(context.navigator.webdriver).toBe(false)
    expect(context.window.chrome).toEqual(
      expect.objectContaining({ csi: expect.any(Function), loadTimes: expect.any(Function) })
    )
  })
})
