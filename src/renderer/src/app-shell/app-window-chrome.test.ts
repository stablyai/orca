import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as AppWindowChrome from './app-window-chrome'

async function loadChromeOnMac(): Promise<typeof AppWindowChrome> {
  vi.resetModules()
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })
  return import('./app-window-chrome')
}

describe('macOS traffic-light inset', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reserves the traffic-light inset in the macOS desktop window', async () => {
    const chrome = await loadChromeOnMac()
    expect(chrome.hasMacTrafficLights).toBe(true)
    expect(chrome.MAC_TRAFFIC_LIGHTS_WIDTH).toBe('80px')
  })

  // #19299: a browser tab has no native window controls to make room for.
  it('reserves nothing in a paired web client on a Mac browser', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const chrome = await loadChromeOnMac()
    expect(chrome.isMac).toBe(true)
    expect(chrome.hasMacTrafficLights).toBe(false)
    expect(chrome.MAC_TRAFFIC_LIGHTS_WIDTH).toBe('0px')
  })
})
