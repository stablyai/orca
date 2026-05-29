import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, appExitMock, appQuitMock, appRelaunchMock } = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, args?: unknown) => unknown>(),
  appExitMock: vi.fn(),
  appQuitMock: vi.fn(),
  appRelaunchMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    exit: appExitMock,
    getAppPath: vi.fn(() => '/test/app'),
    isPackaged: false,
    quit: appQuitMock,
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

const devRelaunchEnvKeys = [
  'ORCA_DEV_RELAUNCH_EXEC_PATH',
  'ORCA_DEV_RELAUNCH_SCRIPT',
  'ORCA_DEV_RELAUNCH_ARGS'
] as const
const originalDevRelaunchEnv = new Map<string, string | undefined>()

describe('registerAppHandlers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    handlers.clear()
    appExitMock.mockReset()
    appQuitMock.mockReset()
    appRelaunchMock.mockReset()
    for (const key of devRelaunchEnvKeys) {
      originalDevRelaunchEnv.set(key, process.env[key])
      delete process.env[key]
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const key of devRelaunchEnvKeys) {
      const originalValue = originalDevRelaunchEnv.get(key)
      if (originalValue === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalValue
      }
    }
    originalDevRelaunchEnv.clear()
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

  it('relaunches through the dev runner when dev relaunch env is present', () => {
    process.env.ORCA_DEV_RELAUNCH_EXEC_PATH = '/usr/local/bin/node'
    process.env.ORCA_DEV_RELAUNCH_SCRIPT = '/repo/config/scripts/run-electron-vite-dev.mjs'
    process.env.ORCA_DEV_RELAUNCH_ARGS = JSON.stringify([
      '--stable-name',
      '--remote-debugging-port=9333'
    ])
    registerAppHandlers({} as never)

    handlers.get('app:relaunch')?.(null)
    vi.advanceTimersByTime(150)

    expect(appRelaunchMock).toHaveBeenCalledWith({
      execPath: '/usr/local/bin/node',
      args: [
        '/repo/config/scripts/run-electron-vite-dev.mjs',
        '--stable-name',
        '--remote-debugging-port=9333'
      ]
    })
    expect(appExitMock).toHaveBeenCalledWith(0)
  })

  it('falls back to Electron relaunch when dev relaunch args are malformed', () => {
    process.env.ORCA_DEV_RELAUNCH_EXEC_PATH = '/usr/local/bin/node'
    process.env.ORCA_DEV_RELAUNCH_SCRIPT = '/repo/config/scripts/run-electron-vite-dev.mjs'
    process.env.ORCA_DEV_RELAUNCH_ARGS = 'not-json'
    registerAppHandlers({} as never)

    handlers.get('app:relaunch')?.(null)
    vi.advanceTimersByTime(150)

    expect(appRelaunchMock).toHaveBeenCalledWith()
    expect(appExitMock).toHaveBeenCalledWith(0)
  })

  it('marks restart as expected shutdown before quitting through the normal pipeline', () => {
    const onBeforeRelaunch = vi.fn()
    registerAppHandlers({} as never, { onBeforeRelaunch })

    handlers.get('app:restart')?.(null)

    expect(onBeforeRelaunch).toHaveBeenCalledTimes(1)
    expect(appRelaunchMock).not.toHaveBeenCalled()
    expect(appQuitMock).not.toHaveBeenCalled()
    expect(appExitMock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(150)

    expect(appRelaunchMock).toHaveBeenCalledTimes(1)
    expect(appQuitMock).toHaveBeenCalledTimes(1)
    expect(appExitMock).not.toHaveBeenCalled()
  })
})
