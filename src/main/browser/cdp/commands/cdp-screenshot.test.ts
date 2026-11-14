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
    webContents.debugger.sendCommand.mockImplementation(async () => {
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
    webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    const capture = asHost(() => captureScreenshot(webContents.guest, { format: 'png' }, noHold))
    url = 'file:///Users/me/private.txt'

    await expect(capture).rejects.toThrow(REFUSED)
    expect(webContents.debugger.sendCommand).toHaveBeenCalledTimes(1)
    expect(webContents.capturePage).not.toHaveBeenCalled()
  })
})
