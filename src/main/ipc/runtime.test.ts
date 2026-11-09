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
import { EphemeralVmFailureError } from '../../shared/ephemeral-vm-failure-copy'

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
    await expect(registration![1]({}, { workspaceId: 'repo::/vm' })).resolves.toEqual({
      ok: true,
      runtime: record
    })
    expect(runtime.wakeWorkspaceVm).toHaveBeenCalledWith('repo::/vm')
  })

  it('returns coded VM wake and suspend failures as values so the code reaches the window', async () => {
    const failure = {
      error: 'Resume exited with code 3.',
      errorCode: 'resumeExited',
      errorParams: { exitCode: 3 }
    }
    const runtime = {
      wakeWorkspaceVm: vi.fn().mockRejectedValue(new EphemeralVmFailureError(failure)),
      suspendWorkspaceVm: vi.fn().mockRejectedValue(new Error('Suspend failed.'))
    }
    registerRuntimeHandlers(runtime as never)
    const handler = (channel: string) =>
      handleMock.mock.calls.find(([registered]) => registered === channel)![1]

    await expect(
      handler('ephemeralVm:resumeWorkspace')({}, { workspaceId: 'repo::/vm' })
    ).resolves.toEqual({ ok: false, ...failure })
    await expect(
      handler('ephemeralVm:suspendWorkspace')({}, { workspaceId: 'repo::/vm' })
    ).resolves.toEqual({ ok: false, error: 'Suspend failed.' })
    expect(runtime.suspendWorkspaceVm).toHaveBeenCalledWith('repo::/vm')
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
