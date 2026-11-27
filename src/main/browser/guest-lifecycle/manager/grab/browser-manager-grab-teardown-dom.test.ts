// @vitest-environment happy-dom
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserManager } from '../browser-manager'
import { attachGrabExecutionTransport } from '../../../element-grab/testing/grab-execution-transport-fixture'
import { executeGrabScript } from '../../../element-grab/grab-guest-execution'
import { createBrowserGuestPickerAuthority } from '../../../../../preload/browser/element-grab/browser-guest-picker-authority'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  WebContentsView: class {},
  app: { getPath: () => '/downloads' },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: () => null }
}))

const HOST_ID = '__orca-grab-host'

afterEach(() => {
  vi.unstubAllGlobals()
  for (const host of document.querySelectorAll(`[id="${HOST_ID}"]`)) {
    host.remove()
  }
})

/**
 * A guest whose document is this test's DOM, judged by the production picker authority. Arming adds
 * a real overlay host, which its page-side teardown removes.
 */
function domGuest() {
  const frames: FrameRequestCallback[] = []
  const load = { loading: false }
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
    frames.push(frame)
    return frames.length
  })
  const authority = createBrowserGuestPickerAuthority(() => true)
  if (!authority) {
    throw new Error('The picker authority needs a DOM')
  }
  const guest = attachGrabExecutionTransport(
    Object.assign(new EventEmitter(), {
      id: 7,
      isDestroyed: () => false,
      isLoadingMainFrame: () => load.loading,
      executeJavaScript: async (code: string) => {
        if (code !== 'arm') {
          return true
        }
        const host = document.createElement('div')
        host.id = HOST_ID
        document.documentElement.appendChild(host)
        return (action: string) => {
          if (action === 'teardown') {
            host.remove()
          }
          return true
        }
      }
    }),
    authority
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: setGrabMode and the execution lanes only call executeJavaScript, executeJavaScriptInIsolatedWorld, on/off/once, isLoadingMainFrame and isDestroyed, which this fixture implements.
  const page = guest as unknown as Electron.WebContents
  const stopLoading = (): void => {
    load.loading = false
    guest.emit('did-stop-loading')
  }
  return { page, frames, load, stopLoading }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

const paintTwoFrames = (frames: FrameRequestCallback[]): void => {
  for (const frame of frames.splice(0)) {
    frame(0)
  }
  for (const frame of frames.splice(0)) {
    frame(0)
  }
}

const overlayHostAttached = (): boolean => document.querySelector(`[id="${HOST_ID}"]`) !== null

/** Arms a picker overlay while loaded, then starts a same-document load and requests the teardown. */
async function originalTeardownDuringLoad({
  strayHostDuringLoad
}: {
  strayHostDuringLoad: boolean
}) {
  const manager = new BrowserManager()
  const { page, frames, load, stopLoading } = domGuest()
  await expect(executeGrabScript(page, 'arm', { overlayControl: true })).resolves.toBe(true)
  expect(overlayHostAttached()).toBe(true)
  load.loading = true
  let settled = false
  const original = manager.setGrabMode('page-1', false, page).then((ok) => {
    settled = true
    return ok
  })
  await flush()
  // Parked during the load: not refused, and no frame requested yet.
  expect({ settled, framesRequested: frames.length }).toEqual({
    settled: false,
    framesRequested: 0
  })
  if (strayHostDuringLoad) {
    // A picker host no arm owns, e.g. one the page put back: only the document itself shows it.
    const stray = document.createElement('div')
    stray.id = HOST_ID
    document.body.appendChild(stray)
  }
  stopLoading()
  await flush()
  paintTwoFrames(frames)
  return { result: await original, hostAttached: overlayHostAttached() }
}

describe('a Draw teardown that began during loading, judged against the document', () => {
  it('removes the overlay host from the document and reports a clean page once the load stops', async () => {
    await expect(originalTeardownDuringLoad({ strayHostDuringLoad: false })).resolves.toEqual({
      result: true,
      hostAttached: false
    })
  })

  it('refuses the same original request when a picker host is in the document at its verdict', async () => {
    await expect(originalTeardownDuringLoad({ strayHostDuringLoad: true })).resolves.toEqual({
      result: false,
      hostAttached: true
    })
  })
})
