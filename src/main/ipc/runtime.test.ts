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
import { setTrustedRendererWebContentsId } from './trusted-renderer-ipc'

const TRUSTED_WEB_CONTENTS_ID = 42

function trustedEvent(): { sender: { id: number; isDestroyed: () => boolean } } {
  return {
    sender: {
      id: TRUSTED_WEB_CONTENTS_ID,
      isDestroyed: () => false
    }
  }
}

describe('registerRuntimeHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    fromWebContentsMock.mockReset()
    setTrustedRendererWebContentsId(TRUSTED_WEB_CONTENTS_ID)
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
    const result = handler(trustedEvent(), { tabs: [], leaves: [] })

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
    const result = await handler(trustedEvent(), { method: 'status.get' })

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
    const result = await handler(trustedEvent(), { method: 'projectGroup.list' })

    expect(result).toMatchObject({
      ok: true,
      result: { groups: [{ id: 'group-1', name: 'Platform' }] },
      _meta: { runtimeId: 'runtime-1' }
    })
  })

  it('rejects generic runtime RPC calls from untrusted senders', async () => {
    const runtime = {
      syncWindowGraph: vi.fn(),
      getStatus: vi.fn(),
      getRuntimeId: vi.fn().mockReturnValue('runtime-1')
    }

    registerRuntimeHandlers(runtime as never)

    const callRegistration = handleMock.mock.calls.find(([channel]) => channel === 'runtime:call')
    expect(callRegistration).toBeTruthy()

    const handler = callRegistration![1]

    expect(() =>
      handler({ sender: { id: 999, isDestroyed: () => false } }, { method: 'status.get' })
    ).toThrow('runtime:call must originate from the trusted Orca renderer')
  })
})
