import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, appExitMock, appRelaunchMock } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  appExitMock: vi.fn(),
  appRelaunchMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    exit: appExitMock,
    getAppPath: vi.fn(() => '/test/app'),
    isPackaged: false,
    relaunch: appRelaunchMock
  },
  BrowserWindow: {
    fromWebContents: vi.fn(() => null)
  },
  dialog: {
    showOpenDialog: vi.fn()
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (_event: unknown, args?: unknown) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: { dev: true }
}))

import { registerAppHandlers } from './app'

describe('registerAppHandlers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    handlers.clear()
    appExitMock.mockReset()
    appRelaunchMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('marks relaunch as expected shutdown before exiting', () => {
    const onBeforeRelaunch = vi.fn()
    registerAppHandlers({} as never, { onBeforeRelaunch })

    handlers.get('app:relaunch')?.(null)

    expect(onBeforeRelaunch).toHaveBeenCalledTimes(1)
    expect(appRelaunchMock).not.toHaveBeenCalled()
    expect(appExitMock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(150)

    expect(appRelaunchMock).toHaveBeenCalledTimes(1)
    expect(appExitMock).toHaveBeenCalledWith(0)
  })
})
