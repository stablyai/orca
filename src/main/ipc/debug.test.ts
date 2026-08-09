import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import { registerDebugHandlers } from './debug'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

const DEBUG_CHANNELS = [
  'debug:start',
  'debug:setBreakpoints',
  'debug:continue',
  'debug:pause',
  'debug:stepOver',
  'debug:stepInto',
  'debug:stepOut',
  'debug:terminate',
  'debug:evaluate',
  'debug:getStackTrace',
  'debug:getVariables',
  'debug:getThreads'
]

function makeMainWindow(): BrowserWindow {
  return { webContents: { send: vi.fn() } } as unknown as BrowserWindow
}

describe('registerDebugHandlers', () => {
  it('registers every debug: channel', () => {
    handleMock.mockClear()
    removeHandlerMock.mockClear()

    registerDebugHandlers(makeMainWindow(), {} as Store)

    expect(handleMock.mock.calls.map(([channel]) => channel).sort()).toEqual(
      [...DEBUG_CHANNELS].sort()
    )
  })

  it('re-registering (e.g. macOS re-activation creating a new window) does not throw and removes prior handlers first', () => {
    handleMock.mockClear()
    removeHandlerMock.mockClear()

    registerDebugHandlers(makeMainWindow(), {} as Store)
    handleMock.mockClear()
    removeHandlerMock.mockClear()

    expect(() => registerDebugHandlers(makeMainWindow(), {} as Store)).not.toThrow()
    expect(removeHandlerMock.mock.calls.map(([channel]) => channel).sort()).toEqual(
      [...DEBUG_CHANNELS].sort()
    )
    expect(handleMock.mock.calls.map(([channel]) => channel).sort()).toEqual(
      [...DEBUG_CHANNELS].sort()
    )
  })
})
