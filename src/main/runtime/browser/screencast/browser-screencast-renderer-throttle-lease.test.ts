/** Hidden host compositors must keep drawing while remote streams need guest frames. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserScreencastOptions } from '../../../browser/cdp/screencast/browser-screencast-stream-types'
import { createScreencastHarness } from './browser-screencast-subscriber-test-harness'
import { RuntimeBrowserCommands } from '../commands/browser-commands'
import { createSinglePageBrowserCommandsHost } from '../client-pages/single-page-browser-commands-host-test-double'

const { webContentsFromId, startBrowserScreencast } = vi.hoisted(() => ({
  webContentsFromId: vi.fn(),
  startBrowserScreencast: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: webContentsFromId }
}))
vi.mock('../../../browser/cdp/screencast/browser-screencast-stream', () => ({
  startBrowserScreencast
}))

type PageStream = { options: BrowserScreencastOptions; close: () => void }

function createRig() {
  const { runtime } = createScreencastHarness()
  const setBackgroundThrottling = vi.fn()
  const window = {
    webContents: {
      isDestroyed: () => false,
      setBackgroundThrottling,
      capturePage: vi.fn(async () => null)
    }
  }
  const guestCalls: unknown[] = []
  const guest = {
    destroyed: false,
    isDestroyed: () => guest.destroyed,
    setBackgroundThrottling: (allowed: boolean) => guestCalls.push(allowed),
    capturePage: async (rect: unknown, opts: unknown) => {
      guestCalls.push({ capture: rect, opts })
      return null
    }
  }
  webContentsFromId.mockReturnValue(guest)
  Object.assign(runtime, {
    browserCommands: new RuntimeBrowserCommands(createSinglePageBrowserCommandsHost(window))
  })
  const pageStreams: PageStream[] = []
  // Model asynchronous teardown: stopping does not close the held stream yet.
  const stopControl = { hold: false }
  startBrowserScreencast.mockImplementation(
    async (_guest: unknown, options: BrowserScreencastOptions) => {
      let close!: () => void
      const done = new Promise<void>((resolve) => {
        close = resolve
      })
      pageStreams.push({ options, close })
      return {
        stop: () => {
          if (!stopControl.hold) {
            close()
          }
        },
        done,
        updateViewport: vi.fn(async () => {}),
        updateFrameBudget: vi.fn(async () => {})
      }
    }
  )

  const subscribe = (connectionId: string, signal?: AbortSignal) => {
    const emit = vi.fn()
    const done = runtime.browserScreencast(
      { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg' },
      { connectionId, clientKind: 'mobile', sendBinary: vi.fn(() => true), signal, emit }
    )
    const ready = async (): Promise<string> => {
      await vi.waitFor(() =>
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }))
      )
      return emit.mock.calls.find(([event]) => event.type === 'ready')?.[0].subscriptionId
    }
    const eventTypes = (): string[] => emit.mock.calls.map(([event]) => event.type)
    return { done, ready, eventTypes }
  }

  return {
    runtime,
    subscribe,
    pageStreams,
    stopControl,
    throttleCalls: () => setBackgroundThrottling.mock.calls.map(([allowed]) => allowed),
    guest,
    guestCalls
  }
}

describe('remote browser screencast renderer throttle lease', () => {
  beforeEach(() => {
    webContentsFromId.mockReset()
    webContentsFromId.mockReturnValue({ isDestroyed: () => false })
    startBrowserScreencast.mockReset()
  })

  // Unsubscribe, disconnect, ghost eviction and page close all settle through done.

  it('starts a fresh stream for a viewer that joins while the errored one tears down', async () => {
    const rig = createRig()
    const phone = rig.subscribe('conn-phone')
    await phone.ready()
    rig.stopControl.hold = true

    rig.pageStreams[0].options.onError?.('Browser stream timed out.')
    const guestLookups = webContentsFromId.mock.calls.length
    const tablet = rig.subscribe('conn-tablet')
    await vi.waitFor(() =>
      expect(webContentsFromId.mock.calls.length).toBeGreaterThan(guestLookups)
    )
    await new Promise((resolve) => setImmediate(resolve))
    rig.pageStreams[0].close()
    await tablet.ready()

    expect(startBrowserScreencast).toHaveBeenCalledTimes(2)
    expect(tablet.eventTypes()).toEqual(['ready'])
    await phone.done
  })
})
