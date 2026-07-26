import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock, fromWebContentsMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  fromWebContentsMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: fromWebContentsMock
  },
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

import { registerRuntimeHandlers } from './runtime'
import { TERMINAL_FIT_RESTORE_DEADLINE_MS } from '../../shared/terminal-fit-restore-deadline'

describe('registerRuntimeHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    fromWebContentsMock.mockReset()
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

    fromWebContentsMock.mockReturnValue({ id: 17 })

    const handler = syncRegistration![1]
    const result = handler({ sender: {} }, { tabs: [], leaves: [] })

    expect(runtime.syncWindowGraph).toHaveBeenCalledWith(17, { tabs: [], leaves: [] })
    expect(result).toEqual({ graphStatus: 'ready' })
  })

  it('routes generic local runtime RPC calls through the dispatcher', async () => {
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
    const result = await handler({ sender: {} }, { method: 'status.get' })

    expect(result).toMatchObject({
      ok: true,
      result: { runtimeId: 'runtime-1', graphStatus: 'ready' },
      _meta: { runtimeId: 'runtime-1' }
    })
  })

  it('registers project group runtime RPC methods for local desktop callers', async () => {
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
    const result = await handler({ sender: {} }, { method: 'projectGroup.list' })

    expect(result).toMatchObject({
      ok: true,
      result: { groups: [{ id: 'group-1', name: 'Platform' }] },
      _meta: { runtimeId: 'runtime-1' }
    })
  })

  it('deduplicates retries while a terminal fit restore is still pending', async () => {
    const finishRestoreByPtyId = new Map<string, (restored: boolean) => void>()
    const reclaimTerminalForDesktop = vi.fn(
      (ptyId: string) =>
        new Promise<boolean>((resolve) => {
          finishRestoreByPtyId.set(ptyId, resolve)
        })
    )
    const runtime = {
      syncWindowGraph: vi.fn(),
      getStatus: vi.fn(),
      reclaimTerminalForDesktop
    }
    registerRuntimeHandlers(runtime as never)
    const restoreRegistration = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:restoreTerminalFit'
    )
    expect(restoreRegistration).toBeTruthy()
    const handler = restoreRegistration![1]

    const first = handler({ sender: {} }, { ptyId: 'pty-1' })
    const retry = handler({ sender: {} }, { ptyId: 'pty-1' })
    const otherTerminal = handler({ sender: {} }, { ptyId: 'pty-2' })

    expect(reclaimTerminalForDesktop).toHaveBeenCalledTimes(2)
    expect(reclaimTerminalForDesktop).toHaveBeenNthCalledWith(1, 'pty-1')
    expect(reclaimTerminalForDesktop).toHaveBeenNthCalledWith(2, 'pty-2')
    finishRestoreByPtyId.get('pty-1')?.(true)
    finishRestoreByPtyId.get('pty-2')?.(true)
    await expect(otherTerminal).resolves.toEqual({ restored: true })
    await expect(first).resolves.toEqual({ restored: true })
    await expect(retry).resolves.toEqual({ restored: true })
    expect(reclaimTerminalForDesktop).toHaveBeenCalledTimes(2)

    const afterSettlement = handler({ sender: {} }, { ptyId: 'pty-1' })
    expect(reclaimTerminalForDesktop).toHaveBeenCalledTimes(3)
    finishRestoreByPtyId.get('pty-1')?.(false)
    await expect(afterSettlement).resolves.toEqual({ restored: false })
  })

  it('bounds retries without accumulating reclaim waiters for one PTY', async () => {
    vi.useFakeTimers()
    try {
      let finishRestore!: (restored: boolean) => void
      const reclaimTerminalForDesktop = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finishRestore = resolve
          })
      )
      registerRuntimeHandlers({
        syncWindowGraph: vi.fn(),
        getStatus: vi.fn(),
        reclaimTerminalForDesktop
      } as never)
      const handler = handleMock.mock.calls.find(
        ([channel]) => channel === 'runtime:restoreTerminalFit'
      )![1]

      const first = handler({ sender: {} }, { ptyId: 'pty-wedged' })
      await vi.advanceTimersByTimeAsync(TERMINAL_FIT_RESTORE_DEADLINE_MS)
      await expect(first).resolves.toEqual({ restored: false })

      const retry = handler({ sender: {} }, { ptyId: 'pty-wedged' })
      expect(reclaimTerminalForDesktop).toHaveBeenCalledTimes(1)
      finishRestore(true)
      await expect(retry).resolves.toEqual({ restored: true })

      const afterSettlement = handler({ sender: {} }, { ptyId: 'pty-wedged' })
      expect(reclaimTerminalForDesktop).toHaveBeenCalledTimes(2)
      finishRestore(false)
      await expect(afterSettlement).resolves.toEqual({ restored: false })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
