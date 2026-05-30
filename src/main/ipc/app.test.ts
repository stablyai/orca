import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

import { registerAppHandlers, validateMassCodeVaultPath } from './app'

describe('registerAppHandlers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    handlers.clear()
    appExitMock.mockReset()
    appQuitMock.mockReset()
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

describe('validateMassCodeVaultPath', () => {
  it('authorizes only directories that look like massCode Markdown vaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-masscode-'))
    try {
      const vault = join(root, 'vault')
      await mkdir(join(vault, 'code'), { recursive: true })

      expect(validateMassCodeVaultPath(vault, root)).toEqual({
        ok: true,
        vaultPath: await realpath(vault)
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects files and folders without massCode type directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-masscode-'))
    try {
      const plainFolder = join(root, 'plain')
      const filePath = join(root, 'not-a-vault')
      await mkdir(plainFolder)
      await writeFile(filePath, 'not a vault')

      expect(validateMassCodeVaultPath(filePath, root)).toEqual({
        ok: false,
        error: 'The selected massCode vault is not a directory.'
      })
      expect(validateMassCodeVaultPath(plainFolder, root)).toEqual({
        ok: false,
        error: 'The selected folder does not look like a massCode Markdown vault.'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects broad home-folder authorization even when it contains type-like folders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-masscode-'))
    try {
      await mkdir(join(root, 'code'))

      expect(validateMassCodeVaultPath(root, root)).toEqual({
        ok: false,
        error: 'Choose the massCode vault directory, not your home folder.'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
