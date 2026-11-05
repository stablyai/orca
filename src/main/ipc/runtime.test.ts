import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, onMock, removeAllListenersMock, removeHandlerMock, fromWebContentsMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    onMock: vi.fn(),
    removeAllListenersMock: vi.fn(),
    removeHandlerMock: vi.fn(),
    fromWebContentsMock: vi.fn()
  }))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: fromWebContentsMock
  },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeAllListeners: removeAllListenersMock,
    removeHandler: removeHandlerMock
  }
}))
import { registerRuntimeHandlers } from './runtime'

describe('registerRuntimeHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    onMock.mockReset()
    removeAllListenersMock.mockReset()
    removeHandlerMock.mockReset()
    fromWebContentsMock.mockReset()
  })

  // #36923: the window's wake shares the runtime's one VM wake path with its sleep's suspend.
  it("routes the window's recipe VM wake through the runtime", async () => {
    const record = { id: 'vm-1', status: 'running' }
    const runtime = { wakeWorkspaceVm: vi.fn().mockResolvedValue(record) }

    registerRuntimeHandlers(runtime as never)

    const registration = handleMock.mock.calls.find(
      ([channel]) => channel === 'ephemeralVm:resumeWorkspace'
    )
    await expect(registration![1]({}, { workspaceId: 'repo::/vm' })).resolves.toBe(record)
    expect(runtime.wakeWorkspaceVm).toHaveBeenCalledWith('repo::/vm')
  })

  // #37067: a phone's re-read on the add's reposChanged came before this publish.

  it('rejects a graph publication queued by a superseded main frame', () => {
    const runtime = {
      syncWindowGraph: vi.fn(),
      getStatus: vi.fn(),
      getRuntimeId: vi.fn()
    }
    registerRuntimeHandlers(runtime as never)
    const handler = handleMock.mock.calls.find(
      ([channel]) => channel === 'runtime:syncWindowGraph'
    )![1]
    const sender = { mainFrame: { generation: 2 } }
    fromWebContentsMock.mockReturnValue({ id: 17 })

    expect(() =>
      handler({ sender, senderFrame: { generation: 1 } }, { tabs: [], leaves: [] })
    ).toThrow('Runtime graph sync must originate from the current main frame')
    expect(runtime.syncWindowGraph).not.toHaveBeenCalled()
  })
})
