/**
 * A remote browser stream keeps the desktop window drawing for exactly as long as it lives: guest
 * frames come from the embedder's compositor, which a throttled hidden window stops running.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserScreencastOptions } from '../browser/browser-screencast-stream-types'
import { createScreencastHarness } from './browser-screencast-subscriber-test-harness'
import { RuntimeBrowserCommands } from './orca-runtime-browser'
import { createSinglePageBrowserCommandsHost } from './single-page-browser-commands-host-test-double'

const { webContentsFromId, startBrowserScreencast } = vi.hoisted(() => ({
  webContentsFromId: vi.fn(),
  startBrowserScreencast: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  webContents: { fromId: webContentsFromId }
}))
vi.mock('../browser/browser-screencast-stream', () => ({ startBrowserScreencast }))

type PageStream = { options: BrowserScreencastOptions; close: () => void }

function createRig() {
  const { runtime } = createScreencastHarness()
  const setBackgroundThrottling = vi.fn()
  const window = { webContents: { isDestroyed: () => false, setBackgroundThrottling } }
  Object.assign(runtime, {
    browserCommands: new RuntimeBrowserCommands(createSinglePageBrowserCommandsHost(window))
  })
  const pageStreams: PageStream[] = []
  // Models Chromium's asynchronous teardown: a held stop leaves the stream open until `close()`.
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
    throttleCalls: () => setBackgroundThrottling.mock.calls.map(([allowed]) => allowed)
  }
}

describe('remote browser screencast renderer throttle lease', () => {
  beforeEach(() => {
    webContentsFromId.mockReset()
    webContentsFromId.mockReturnValue({ isDestroyed: () => false })
    startBrowserScreencast.mockReset()
  })

  it('lifts the window throttle before the stream starts capturing', async () => {
    const rig = createRig()
    let callsAtStart: boolean[] = []
    const started = startBrowserScreencast.getMockImplementation()
    startBrowserScreencast.mockImplementation(async (...args: unknown[]) => {
      callsAtStart = rig.throttleCalls()
      return started?.(...args)
    })

    const phone = rig.subscribe('conn-phone')
    await phone.ready()

    expect(callsAtStart).toEqual([false])
  })

  // Unsubscribe, connection close, ghost eviction and a desktop page close all end through the
  // page stream's `done`, so one of them stands for all.
  it('restores it when the stream ends', async () => {
    const rig = createRig()
    const phone = rig.subscribe('conn-phone')
    const subscriptionId = await phone.ready()

    rig.runtime.cleanupSubscription(subscriptionId)
    await phone.done

    await vi.waitFor(() => expect(rig.throttleCalls()).toEqual([false, true]))
  })

  it('restores it when the stream fails to start', async () => {
    const rig = createRig()
    startBrowserScreencast.mockRejectedValue(new Error('Could not attach debugger.'))
    const phone = rig.subscribe('conn-phone')

    await expect(phone.done).rejects.toThrow('Could not attach debugger.')

    await vi.waitFor(() => expect(rig.throttleCalls()).toEqual([false, true]))
  })

  it('ends the stream on an error, then restores it', async () => {
    const rig = createRig()
    const phone = rig.subscribe('conn-phone')
    await phone.ready()

    rig.pageStreams[0].options.onError?.('Browser stream timed out.')
    await phone.done

    expect(phone.eventTypes()).toEqual(['ready', 'error', 'end'])
    await vi.waitFor(() => expect(rig.throttleCalls()).toEqual([false, true]))
  })

  it('starts a fresh stream for a viewer that joins while the errored one tears down', async () => {
    const rig = createRig()
    const phone = rig.subscribe('conn-phone')
    await phone.ready()
    rig.stopControl.hold = true

    rig.pageStreams[0].options.onError?.('Browser stream timed out.')
    const guestLookups = webContentsFromId.mock.calls.length
    const tablet = rig.subscribe('conn-tablet')
    // Past its guest lookup, the joiner reaches the page record with no further await.
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

  it('restores it when the subscription is aborted before ready', async () => {
    const rig = createRig()
    let releaseStart!: () => void
    const started = startBrowserScreencast.getMockImplementation()
    startBrowserScreencast.mockImplementation(async (...args: unknown[]) => {
      await new Promise<void>((resolve) => {
        releaseStart = resolve
      })
      return started?.(...args)
    })
    const abort = new AbortController()
    const phone = rig.subscribe('conn-phone', abort.signal)
    await vi.waitFor(() => expect(releaseStart).toBeTypeOf('function'))

    abort.abort()
    releaseStart()
    await phone.done

    expect(phone.eventTypes()).not.toContain('ready')
    await vi.waitFor(() => expect(rig.throttleCalls()).toEqual([false, true]))
  })
})
