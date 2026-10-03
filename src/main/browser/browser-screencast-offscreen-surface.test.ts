import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startBrowserScreencast } from './browser-screencast-stream'
import { createMockScreencastWebContents } from './browser-screencast-web-contents-test-double'

const electronMocks = vi.hoisted(() => ({ fromWebContents: vi.fn() }))
vi.mock('electron', () => ({ BrowserWindow: electronMocks }))

function fixture() {
  let size: [number, number] = [1280, 800]
  const owner = {
    isDestroyed: vi.fn(() => false),
    getContentSize: () => size,
    setContentSize: vi.fn((width: number, height: number) => {
      size = [width, height]
    })
  }
  const guest = { ...createMockScreencastWebContents(), isOffscreen: vi.fn(() => true) }
  electronMocks.fromWebContents.mockReturnValue(owner)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fake implements every WebContents member the real screencast path invokes.
  const webContents = guest as unknown as WebContents
  const options = {
    format: 'jpeg' as const,
    quality: 72,
    maxWidth: 900,
    maxHeight: 1335,
    viewportWidth: 360,
    viewportHeight: 534,
    deviceScaleFactor: 2,
    everyNthFrame: 1,
    minFrameIntervalMs: 0,
    onFrame: vi.fn()
  }
  return { guest, webContents, owner, start: () => startBrowserScreencast(webContents, options) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('offscreen screencast surface ownership', () => {
  it('matches the shared viewport, avoids redundant resizing and restores the original size', async () => {
    const { guest, owner, start } = fixture()
    const session = await start()
    await vi.waitFor(() =>
      expect(guest.debugger.sendCommand).toHaveBeenCalledWith(
        'Page.captureScreenshot',
        expect.anything()
      )
    )
    expect(owner.setContentSize).toHaveBeenCalledExactlyOnceWith(360, 534)
    await session.updateViewport({ viewportWidth: 534, viewportHeight: 360 })
    expect(owner.getContentSize()).toEqual([534, 360])
    session.stop()
    await session.done
    expect(owner.getContentSize()).toEqual([1280, 800])
    expect(owner.setContentSize.mock.calls).toEqual([
      [360, 534],
      [534, 360],
      [1280, 800]
    ])
  })

  it('restores the surface when the first emulation command fails', async () => {
    const { guest, webContents, owner, start } = fixture()
    guest.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Emulation.setDeviceMetricsOverride') {
        throw new Error('emulation refused')
      }
      return {}
    })
    await expect(start()).rejects.toThrow('emulation refused')
    expect(owner.getContentSize()).toEqual([1280, 800])
    expect(webContents.debugger.isAttached()).toBe(false)
  })

  it('restores the surface when the debugger detaches without an explicit stop', async () => {
    const { guest, webContents, owner, start } = fixture()
    const session = await start()
    await vi.waitFor(() =>
      expect(guest.debugger.sendCommand).toHaveBeenCalledWith(
        'Page.captureScreenshot',
        expect.anything()
      )
    )
    webContents.debugger.detach()
    guest.debugger.emit('detach', {}, 'target_closed')
    await session.done
    expect(owner.getContentSize()).toEqual([1280, 800])
    expect(guest.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Emulation.clearDeviceMetricsOverride',
      {}
    )
  })

  it('does not resize a crashed renderer before the guarded CDP command rejects', async () => {
    const { guest, owner, start } = fixture()
    guest.isCrashed.mockReturnValue(true)
    await expect(start()).rejects.toThrow('page crashed')
    expect(owner.setContentSize).not.toHaveBeenCalled()
    expect(guest.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Emulation.clearDeviceMetricsOverride',
      {}
    )
  })

  it.each(['Page.enable', 'Emulation.setDeviceMetricsOverride', 'Page.startScreencast'])(
    'rejects a late startup completion after detach during %s',
    async (methodToDelay) => {
      const { guest, webContents, owner, start } = fixture()
      let resume: (() => void) | undefined
      guest.debugger.sendCommand.mockImplementation(async (method: string) => {
        if (method === methodToDelay) {
          await new Promise<void>((resolve) => {
            resume = resolve
          })
        }
        return {}
      })
      const starting = start()
      await vi.waitFor(() => expect(resume).toBeDefined())
      webContents.debugger.detach()
      guest.debugger.emit('detach', {}, 'target_closed')
      resume?.()
      await expect(starting).rejects.toThrow('debugger detached')
      expect(owner.getContentSize()).toEqual([1280, 800])
    }
  )

  it('does not resize a desktop guest', async () => {
    const { guest, owner, start } = fixture()
    guest.isOffscreen.mockReturnValue(false)
    const session = await start()
    session.stop()
    await session.done
    expect(owner.setContentSize).not.toHaveBeenCalled()
  })

  it('does not clear an unapplied desktop override after a rejected command', async () => {
    const { guest, start } = fixture()
    guest.isOffscreen.mockReturnValue(false)
    guest.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Emulation.setDeviceMetricsOverride') {
        throw new Error('emulation refused')
      }
      return {}
    })
    await expect(start()).rejects.toThrow('emulation refused')
    expect(guest.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Emulation.clearDeviceMetricsOverride',
      {}
    )
  })

  it('avoids native resizing and clearing after an active renderer crashes', async () => {
    const { guest, owner, start } = fixture()
    const session = await start()
    await vi.waitFor(() =>
      expect(guest.debugger.sendCommand).toHaveBeenCalledWith(
        'Page.captureScreenshot',
        expect.anything()
      )
    )
    owner.setContentSize.mockClear()
    guest.isCrashed.mockReturnValue(true)
    session.stop()
    await session.done
    expect(owner.setContentSize).not.toHaveBeenCalled()
    expect(guest.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Emulation.clearDeviceMetricsOverride',
      {}
    )
  })

  it('keeps the stream usable when the host has no window owner', async () => {
    const { owner, start } = fixture()
    electronMocks.fromWebContents.mockReturnValue(null)
    const session = await start()
    session.stop()
    await session.done
    expect(owner.setContentSize).not.toHaveBeenCalled()
  })
})
