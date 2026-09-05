import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getAllWindowsMock, handleMock, removeHandlerMock, sendMock } = vi.hoisted(() => ({
  getAllWindowsMock: vi.fn(),
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  sendMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: getAllWindowsMock },
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

import { registerCodexMicroIpc } from './ipc'
import { buildCodexMicroLightingSnapshot } from './lighting-snapshot'

describe('registerCodexMicroIpc', () => {
  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    sendMock.mockReset()
    getAllWindowsMock.mockReturnValue([
      { isDestroyed: () => false, webContents: { send: sendMock } }
    ])
  })

  it('registers bounded handlers and broadcasts parsed updates', async () => {
    let stateListener: ((state: unknown) => void) | undefined
    let inputListener: ((input: unknown) => void) | undefined
    const coordinator = {
      getState: vi.fn(() => ({ kind: 'disconnected' })),
      retry: vi.fn(),
      release: vi.fn(),
      setOutputSnapshot: vi.fn(),
      subscribeState: vi.fn((listener) => {
        stateListener = listener
        return vi.fn()
      }),
      subscribeInput: vi.fn((listener) => {
        inputListener = listener
        return vi.fn()
      })
    }
    registerCodexMicroIpc(coordinator as never)
    const handlers = new Map(
      handleMock.mock.calls.map(([channel, callback]) => [channel, callback])
    )

    expect(await handlers.get('codexMicro:getState')!()).toEqual({ kind: 'disconnected' })
    const snapshot = buildCodexMicroLightingSnapshot({ enabled: true, brightness: 50 })
    await handlers.get('codexMicro:setOutputSnapshot')!({}, snapshot)
    expect(coordinator.setOutputSnapshot).toHaveBeenCalledWith(snapshot.rgbcfg, snapshot.thstatus)
    expect(() =>
      handlers.get('codexMicro:setOutputSnapshot')!({}, { rgbcfg: {}, thstatus: [] })
    ).toThrow('Invalid Codex Micro output snapshot')
    stateListener?.({ kind: 'connecting' })
    inputListener?.({ kind: 'control', control: 'AG00', action: 1 })
    expect(sendMock).toHaveBeenCalledWith('codexMicro:state', { kind: 'connecting' })
    expect(sendMock).toHaveBeenCalledWith('codexMicro:input', {
      kind: 'control',
      control: 'AG00',
      action: 1
    })
  })
})
