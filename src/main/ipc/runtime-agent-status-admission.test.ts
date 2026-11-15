import { beforeEach, expect, it, vi } from 'vitest'

const { handleMock, fromWebContentsMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  fromWebContentsMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: fromWebContentsMock
  },
  ipcMain: {
    handle: handleMock,
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn()
  }
}))
import { registerRuntimeHandlers } from './runtime'

beforeEach(() => {
  handleMock.mockReset()
  fromWebContentsMock.mockReset()
})

it('admits status only from the current main frame without establishing graph authority', () => {
  const runtime = { syncRendererAgentStatus: vi.fn().mockReturnValue({ accepted: true }) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the status channel calls only syncRendererAgentStatus on this runtime.
  registerRuntimeHandlers(runtime as never)
  const handler = handleMock.mock.calls.find(
    ([channel]) => channel === 'runtime:syncAgentStatus'
  )![1]
  const frame = { generation: 2 }
  const sender = { mainFrame: frame }
  const batch = { type: 'snapshot', epoch: 'renderer', seq: 1, rows: [] }
  fromWebContentsMock.mockReturnValue({ id: 17 })
  expect(handler({ sender, senderFrame: { generation: 1 } }, batch)).toEqual({
    accepted: false,
    reason: 'superseded'
  })
  expect(runtime.syncRendererAgentStatus).not.toHaveBeenCalled()
  expect(handler({ sender, senderFrame: frame }, batch)).toEqual({ accepted: true })
  expect(runtime.syncRendererAgentStatus).toHaveBeenCalledWith(17, batch)
  fromWebContentsMock.mockReturnValue(null)
  expect(handler({ sender, senderFrame: frame }, batch)).toEqual({
    accepted: false,
    reason: 'superseded'
  })
})
