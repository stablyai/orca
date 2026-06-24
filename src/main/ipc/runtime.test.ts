import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock, getMainWindowForWebContentsMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  getMainWindowForWebContentsMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

vi.mock('../window/main-window-registry', () => ({
  getMainWindowForWebContents: getMainWindowForWebContentsMock
}))

import { registerRuntimeHandlers } from './runtime'

function getRegisteredHandler(channel: string) {
  const registration = handleMock.mock.calls.find(([name]) => name === channel)
  expect(registration).toBeTruthy()
  return registration![1]
}

describe('registerRuntimeHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    getMainWindowForWebContentsMock.mockReset()
  })

  it('routes sync requests through the authoritative browser window id', () => {
    const runtime = {
      syncWindowGraph: vi.fn().mockReturnValue({ graphStatus: 'ready' }),
      getStatus: vi.fn().mockReturnValue({ graphStatus: 'unavailable' }),
      getRuntimeId: vi.fn().mockReturnValue('runtime-1')
    }

    registerRuntimeHandlers(runtime as never)

    const syncRegistration = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:syncWindowGraph'
    )
    expect(syncRegistration).toBeTruthy()

    getMainWindowForWebContentsMock.mockReturnValue({ id: 17 })

    const handler = syncRegistration![1]
    const result = handler({ sender: {} }, { tabs: [], leaves: [] })

    expect(runtime.syncWindowGraph).toHaveBeenCalledWith(17, { tabs: [], leaves: [] })
    expect(result).toEqual({ graphStatus: 'ready' })
  })

  it('routes generic local runtime RPC calls through the dispatcher', async () => {
    const sender = {}
    const runtime = {
      syncWindowGraph: vi.fn(),
      getStatus: vi.fn().mockReturnValue({
        runtimeId: 'runtime-1',
        rendererGraphEpoch: 0,
        graphStatus: 'ready',
        authoritativeWindowId: null,
        liveTabCount: 0,
        liveLeafCount: 0
      }),
      getRuntimeId: vi.fn().mockReturnValue('runtime-1')
    }

    registerRuntimeHandlers(runtime as never)

    const callRegistration = handleMock.mock.calls.find(([channel]) => channel === 'runtime:call')
    expect(callRegistration).toBeTruthy()

    const handler = callRegistration![1]
    getMainWindowForWebContentsMock.mockReturnValue({ id: 17 })
    const result = await handler({ sender }, { method: 'status.get' })

    expect(result).toMatchObject({
      ok: true,
      result: { runtimeId: 'runtime-1', graphStatus: 'ready' },
      _meta: { runtimeId: 'runtime-1' }
    })
  })

  it('registers project group runtime RPC methods for local desktop callers', async () => {
    const sender = {}
    const runtime = {
      syncWindowGraph: vi.fn(),
      getStatus: vi.fn(),
      getRuntimeId: vi.fn().mockReturnValue('runtime-1'),
      listProjectGroups: vi.fn().mockReturnValue([{ id: 'group-1', name: 'Platform' }])
    }

    registerRuntimeHandlers(runtime as never)

    const callRegistration = handleMock.mock.calls.find(([channel]) => channel === 'runtime:call')
    expect(callRegistration).toBeTruthy()

    const handler = callRegistration![1]
    getMainWindowForWebContentsMock.mockReturnValue({ id: 17 })
    const result = await handler({ sender }, { method: 'projectGroup.list' })

    expect(result).toMatchObject({
      ok: true,
      result: { groups: [{ id: 'group-1', name: 'Platform' }] },
      _meta: { runtimeId: 'runtime-1' }
    })
  })

  it('rejects generic local runtime RPC calls from unregistered senders', async () => {
    const runtime = {
      syncWindowGraph: vi.fn(),
      getStatus: vi.fn(),
      getRuntimeId: vi.fn().mockReturnValue('runtime-1')
    }

    registerRuntimeHandlers(runtime as never)

    const callRegistration = handleMock.mock.calls.find(([channel]) => channel === 'runtime:call')
    expect(callRegistration).toBeTruthy()

    const handler = callRegistration![1]
    await expect(handler({ sender: {} }, { method: 'status.get' })).rejects.toThrow(
      'Runtime IPC calls must originate from a BrowserWindow'
    )
  })

  it('scopes direct runtime hydration snapshots to the sender window owner graph', () => {
    const sender = {}
    const runtime = {
      syncWindowGraph: vi.fn(),
      getStatus: vi.fn(),
      getRuntimeId: vi.fn().mockReturnValue('runtime-1'),
      getAllTerminalFitOverrides: vi.fn().mockReturnValue(
        new Map([
          ['pty-owned', { mode: 'mobile-fit', cols: 100, rows: 40 }],
          ['pty-other', { mode: 'mobile-fit', cols: 80, rows: 24 }]
        ])
      ),
      getAllTerminalDrivers: vi.fn().mockReturnValue(
        new Map([
          ['pty-owned', { kind: 'mobile', clientId: 'phone-owned' }],
          ['pty-other', { kind: 'mobile', clientId: 'phone-other' }]
        ])
      ),
      getAllBrowserDrivers: vi.fn().mockReturnValue(
        new Map([
          ['browser-owned', { kind: 'mobile', clientId: 'phone-owned' }],
          ['browser-other', { kind: 'mobile', clientId: 'phone-other' }]
        ])
      ),
      resolveOwnerWindowIdForPtyId: vi.fn((ptyId: string) => (ptyId === 'pty-owned' ? 17 : 23)),
      resolveOwnerWindowIdForBrowserPageId: vi.fn((pageId: string) =>
        pageId === 'browser-owned' ? 17 : 23
      )
    }

    registerRuntimeHandlers(runtime as never)
    getMainWindowForWebContentsMock.mockReturnValue({ id: 17 })

    expect(getRegisteredHandler('runtime:getTerminalFitOverrides')({ sender })).toEqual([
      { ptyId: 'pty-owned', mode: 'mobile-fit', cols: 100, rows: 40 }
    ])
    expect(getRegisteredHandler('runtime:getTerminalDrivers')({ sender })).toEqual([
      { ptyId: 'pty-owned', driver: { kind: 'mobile', clientId: 'phone-owned' } }
    ])
    expect(getRegisteredHandler('runtime:getBrowserDrivers')({ sender })).toEqual([
      {
        browserPageId: 'browser-owned',
        driver: { kind: 'mobile', clientId: 'phone-owned' }
      }
    ])
  })

  it('fails direct desktop reclaim IPC closed for non-owner windows', async () => {
    const sender = {}
    const runtime = {
      syncWindowGraph: vi.fn(),
      getStatus: vi.fn(),
      getRuntimeId: vi.fn().mockReturnValue('runtime-1'),
      resolveOwnerWindowIdForPtyId: vi.fn(() => 23),
      resolveOwnerWindowIdForBrowserPageId: vi.fn(() => 23),
      reclaimTerminalForDesktop: vi.fn().mockResolvedValue(true),
      reclaimBrowserForDesktop: vi.fn().mockReturnValue(true)
    }

    registerRuntimeHandlers(runtime as never)
    getMainWindowForWebContentsMock.mockReturnValue({ id: 17 })

    await expect(
      getRegisteredHandler('runtime:restoreTerminalFit')({ sender }, { ptyId: 'pty-other' })
    ).resolves.toEqual({ restored: false })
    expect(
      getRegisteredHandler('runtime:reclaimBrowserForDesktop')(
        { sender },
        { browserPageId: 'browser-other' }
      )
    ).toEqual({ reclaimed: false })
    expect(runtime.reclaimTerminalForDesktop).not.toHaveBeenCalled()
    expect(runtime.reclaimBrowserForDesktop).not.toHaveBeenCalled()
  })

  it('ignores spoofed window ids in direct desktop reclaim IPC args', async () => {
    const sender = {}
    const runtime = {
      syncWindowGraph: vi.fn(),
      getStatus: vi.fn(),
      getRuntimeId: vi.fn().mockReturnValue('runtime-1'),
      resolveOwnerWindowIdForPtyId: vi.fn(() => 23),
      resolveOwnerWindowIdForBrowserPageId: vi.fn(() => 23),
      reclaimTerminalForDesktop: vi.fn().mockResolvedValue(true),
      reclaimBrowserForDesktop: vi.fn().mockReturnValue(true)
    }

    registerRuntimeHandlers(runtime as never)
    getMainWindowForWebContentsMock.mockReturnValue({ id: 17 })

    await expect(
      getRegisteredHandler('runtime:restoreTerminalFit')(
        { sender },
        { ptyId: 'pty-other', senderWindowId: 23, windowId: 23 }
      )
    ).resolves.toEqual({ restored: false })
    expect(
      getRegisteredHandler('runtime:reclaimBrowserForDesktop')(
        { sender },
        { browserPageId: 'browser-other', senderWindowId: 23, windowId: 23 }
      )
    ).toEqual({ reclaimed: false })
    expect(runtime.reclaimTerminalForDesktop).not.toHaveBeenCalled()
    expect(runtime.reclaimBrowserForDesktop).not.toHaveBeenCalled()
  })

  it('allows direct desktop reclaim IPC for the owning window', async () => {
    const sender = {}
    const runtime = {
      syncWindowGraph: vi.fn(),
      getStatus: vi.fn(),
      getRuntimeId: vi.fn().mockReturnValue('runtime-1'),
      resolveOwnerWindowIdForPtyId: vi.fn(() => 17),
      resolveOwnerWindowIdForBrowserPageId: vi.fn(() => 17),
      reclaimTerminalForDesktop: vi.fn().mockResolvedValue(true),
      reclaimBrowserForDesktop: vi.fn().mockReturnValue(true)
    }

    registerRuntimeHandlers(runtime as never)
    getMainWindowForWebContentsMock.mockReturnValue({ id: 17 })

    await expect(
      getRegisteredHandler('runtime:restoreTerminalFit')({ sender }, { ptyId: 'pty-owned' })
    ).resolves.toEqual({ restored: true })
    expect(
      getRegisteredHandler('runtime:reclaimBrowserForDesktop')(
        { sender },
        { browserPageId: 'browser-owned' }
      )
    ).toEqual({ reclaimed: true })
    expect(runtime.reclaimTerminalForDesktop).toHaveBeenCalledWith('pty-owned')
    expect(runtime.reclaimBrowserForDesktop).toHaveBeenCalledWith('browser-owned')
  })
})
