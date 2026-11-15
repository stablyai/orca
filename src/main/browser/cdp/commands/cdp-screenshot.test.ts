import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runInRemoteCliBrowserScope } from '../../../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import { captureScreenshot } from './cdp-screenshot'

function createMockWebContents() {
  const mock = {
    id: 7,
    isDestroyed: vi.fn(() => false),
    invalidate: vi.fn(),
    capturePage: vi.fn(),
    debugger: {
      isAttached: vi.fn(() => true),
      sendCommand: vi.fn()
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements every WebContents member the capture calls.
  return Object.assign(mock, { guest: mock as unknown as WebContents })
}

const noHold = (): (() => void) => () => {}

describe('an SSH host’s capture', () => {
  let url = 'https://example.com/'
  const asHost = <T>(run: () => Promise<T>): Promise<T> =>
    runInRemoteCliBrowserScope('wt-1', run, undefined, () => url.startsWith('https:'))
  const REFUSED =
    "This page is not browsing through the SSH host, so the host's orca CLI cannot use it."

  afterEach(() => {
    url = 'https://example.com/'
  })

  it('refuses a capture whose frame was drawn after the page moved to a desktop file', async () => {
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method !== 'Page.captureScreenshot') {
        return {}
      }
      url = 'file:///Users/me/private.txt'
      return { data: 'private-pixels' }
    })

    await expect(
      asHost(() => captureScreenshot(webContents.guest, { format: 'png' }, noHold))
    ).rejects.toThrow(REFUSED)
  })

  it('stops at the next probe once the page moved to a desktop file, never falling back', async () => {
    // Fake timers do not carry the host command context into probes.
    const webContents = createMockWebContents()
    webContents.debugger.sendCommand.mockImplementation((method: string) =>
      method === 'Page.captureScreenshot' ? new Promise(() => {}) : Promise.resolve({})
    )
    const capture = asHost(() => captureScreenshot(webContents.guest, { format: 'png' }, noHold))
    await vi.waitFor(() => expect(webContents.debugger.sendCommand).toHaveBeenCalledTimes(3))
    url = 'file:///Users/me/private.txt'

    await expect(capture).rejects.toThrow(REFUSED)
    expect(webContents.debugger.sendCommand).toHaveBeenCalledTimes(3)
    expect(webContents.capturePage).not.toHaveBeenCalled()
  })
})

describe('a capture of a page with an emulated device pixel ratio', () => {
  it('asks for the visible area at the density the page really draws, so it is not tiled', async () => {
    const webContents = createMockWebContents()
    // `orca viewport --scale 3` on a 125% Windows display.
    webContents.debugger.sendCommand.mockImplementation(async (method: string) =>
      method === 'Runtime.evaluate'
        ? { result: { value: 3 } }
        : method === 'Page.getLayoutMetrics'
          ? {
              cssContentSize: { width: 390, height: 844 },
              cssVisualViewport: {
                pageX: 0,
                pageY: 0,
                clientWidth: 390,
                clientHeight: 844,
                scale: 1,
                zoom: 1
              },
              visualViewport: { clientWidth: 487.5, clientHeight: 1055 }
            }
          : { data: 'pixels' }
    )

    await expect(
      captureScreenshot(webContents.guest, { format: 'png', fromSurface: true }, noHold)
    ).resolves.toEqual({ data: 'pixels' })
    const captures = webContents.debugger.sendCommand.mock.calls.filter(
      ([method]) => method === 'Page.captureScreenshot'
    )
    const clip = captures.at(-1)?.[1]?.clip
    expect(clip).toMatchObject({ x: 0, y: 0, width: 390, height: 844 })
    // 487 whole device pixels across: 390 * 0.41624 * 3 = 487.
    expect(clip.scale).toBeCloseTo(0.41624, 5)
  })
})
