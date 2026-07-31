import { afterEach, describe, expect, it, vi } from 'vitest'

const getVersionManagerBinPathsMock = vi.fn<() => string[]>()

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => ''),
    setPath: vi.fn(),
    quit: vi.fn(),
    exit: vi.fn(),
    isPackaged: true,
    commandLine: {
      appendSwitch: vi.fn(),
      getSwitchValue: vi.fn(() => '')
    }
  }
}))

vi.mock('../codex-cli/command', () => ({
  getVersionManagerBinPaths: getVersionManagerBinPathsMock
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const originalPath = process.env.PATH
const originalWindowsPath = process.env.Path

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  if (originalPath === undefined) {
    delete process.env.PATH
  } else {
    process.env.PATH = originalPath
  }
  if (originalWindowsPath === undefined) {
    delete process.env.Path
  } else {
    process.env.Path = originalWindowsPath
  }
  getVersionManagerBinPathsMock.mockReset()
})

describe('packaged process PATH mutation', () => {
  it('leaves the packaged Windows process PATH untouched', async () => {
    setPlatform('win32')
    process.env.Path = 'C:\\Windows\\System32'
    getVersionManagerBinPathsMock.mockReturnValue(['C:\\fnm\\aliases\\default'])
    const { patchPackagedProcessPath } = await import('./configure-process')

    patchPackagedProcessPath()

    expect(process.env.Path).toBe('C:\\Windows\\System32')
    expect(getVersionManagerBinPathsMock).not.toHaveBeenCalled()
  })

  it('preserves the non-Windows path route used by Linux and WSL', async () => {
    setPlatform('linux')
    process.env.PATH = '/usr/bin'
    getVersionManagerBinPathsMock.mockReturnValue(['/home/test/.fnm/aliases/default/bin'])
    const { patchPackagedProcessPath } = await import('./configure-process')

    patchPackagedProcessPath()

    expect(process.env.PATH?.split(':')).toContain('/home/test/.fnm/aliases/default/bin')
  })
})
