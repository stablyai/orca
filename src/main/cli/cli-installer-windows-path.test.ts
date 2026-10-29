import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir()
  }
}))

import { CliInstaller } from './cli-installer'
import {
  WindowsUserPathRegistryReader,
  type WindowsUserPathReadResult
} from './windows-user-path-registry'
import { makeFixture } from './cli-installer-test-fixtures'

function userPathRead(value: string | null, expandable = false): WindowsUserPathReadResult {
  return { state: 'success', value, expandable }
}

describe('CliInstaller', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('creates a windows wrapper and updates the user PATH', async () => {
    const fixture = await makeFixture()
    const installPath = join(fixture.root, 'Programs', 'Orca', 'bin', 'orca.cmd')
    let userPath = 'C:\\Windows\\System32'
    const installer = new CliInstaller({
      platform: 'win32',
      isPackaged: false,
      userDataPath: fixture.userDataPath,
      execPath: 'C:\\Users\\me\\AppData\\Local\\Orca\\Orca.exe',
      appPath: fixture.appPath,
      commandPathOverride: installPath,
      userPathReader: async () => userPathRead(userPath),
      userPathWriter: async (value) => {
        userPath = value
      }
    })

    const installed = await installer.install()
    expect(installed.state).toBe('installed')
    expect(installed.pathConfigured).toBe(true)
    expect(userPath).toContain(join(fixture.root, 'Programs', 'Orca', 'bin'))

    const wrapperContent = await readFile(installPath, 'utf8')
    expect(wrapperContent).toContain('ORCA_LAUNCHER=')
    expect(wrapperContent).toContain('orca.cmd')
    const launcherContent = await readFile(installed.launcherPath as string, 'utf8')
    expect(launcherContent).toContain(`set "ORCA_USER_DATA_PATH=${fixture.userDataPath}"`)
    expect(launcherContent).toContain('set "ORCA_APP_EXECUTABLE=%ELECTRON%"')

    const removed = await installer.remove()
    expect(removed.state).toBe('not_installed')
    expect(userPath).not.toContain(join(fixture.root, 'Programs', 'Orca', 'bin'))
  })

  it.each(['UnauthorizedAccessException', 'SecurityException'])(
    'rejects with a friendly message for Windows PATH denial: %s',
    async (permissionMarker) => {
      const fixture = await makeFixture()
      const installPath = join(fixture.root, 'Programs', 'Orca', 'bin', 'orca.cmd')
      const installer = new CliInstaller({
        platform: 'win32',
        isPackaged: false,
        userDataPath: fixture.userDataPath,
        execPath: 'C:\\Users\\me\\AppData\\Local\\Orca\\Orca.exe',
        appPath: fixture.appPath,
        commandPathOverride: installPath,
        userPathReader: async () => userPathRead('C:\\Windows\\System32'),
        userPathWriter: async () => {
          // The .NET error id survives localized or mojibake PowerShell output.
          const error = new Error(
            `Command failed: powershell -NoProfile -Command [Environment]::SetEnvironmentVariable('Path', '...', 'User')\nFullyQualifiedErrorId : ${permissionMarker},Microsoft.PowerShell.Commands`
          )
          Object.assign(error, { code: 1 })
          throw error
        }
      })

      const result = installer.install()
      await expect(result).rejects.toThrow(/access denied|Group Policy|manually/i)
      await expect(result).rejects.not.toThrow(/Command failed: powershell/)
      await expect(result).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringContaining(permissionMarker)
        })
      })
    }
  )

  it('fails closed without writing when a Windows PATH mutation cannot read the registry', async () => {
    const fixture = await makeFixture()
    const userPathWriter = vi.fn()
    const installer = new CliInstaller({
      platform: 'win32',
      isPackaged: false,
      userDataPath: fixture.userDataPath,
      execPath: 'C:\\Users\\me\\AppData\\Local\\Orca\\Orca.exe',
      appPath: fixture.appPath,
      commandPathOverride: join(fixture.root, 'Programs', 'Orca', 'bin', 'orca.cmd'),
      userPathReader: async () => ({
        state: 'unknown',
        detail: 'Orca could not read the Windows user PATH registry value.'
      }),
      userPathWriter
    })

    await expect(installer.install()).rejects.toThrow('No PATH changes were made')
    expect(userPathWriter).not.toHaveBeenCalled()
  })

  it('bypasses cached status data before a Windows PATH mutation', async () => {
    const fixture = await makeFixture()
    const installPath = join(fixture.root, 'Programs', 'Orca', 'bin', 'orca.cmd')
    const pathDirectory = dirname(installPath)
    let registryPath = 'C:\\Tools'
    const registryReader = new WindowsUserPathRegistryReader({
      platform: 'win32',
      registryLoader: async () => ({
        HK: { CU: 0x80000001, LM: 0x80000002 },
        getRegistryKey: () => ({
          Path: { name: 'Path', type: 2, value: registryPath }
        })
      })
    })
    const userPathWriter = vi.fn(async (value: string) => {
      registryPath = value
    })
    const installer = new CliInstaller({
      platform: 'win32',
      isPackaged: false,
      userDataPath: fixture.userDataPath,
      execPath: 'C:\\Users\\me\\AppData\\Local\\Orca\\Orca.exe',
      appPath: fixture.appPath,
      commandPathOverride: installPath,
      userPathReader: () => registryReader.read(),
      userPathMutationReader: () => registryReader.readFresh(),
      userPathWriter,
      userPathCacheInvalidator: () => registryReader.invalidate()
    })

    await installer.getStatus()
    registryPath = 'C:\\Tools;C:\\AddedByAnotherInstaller'
    await installer.install()

    expect(userPathWriter).toHaveBeenCalledWith(
      `C:\\Tools;C:\\AddedByAnotherInstaller;${pathDirectory}`
    )
  })

  it('matches expandable Windows PATH entries case-insensitively without rewriting them', async () => {
    const fixture = await makeFixture()
    const installPath = join(fixture.root, 'Local App Data', 'Orca', 'bin', 'orca.cmd')
    const userPathWriter = vi.fn()
    const installer = new CliInstaller({
      platform: 'win32',
      isPackaged: false,
      userDataPath: fixture.userDataPath,
      execPath: 'C:\\Users\\me\\AppData\\Local\\Orca\\Orca.exe',
      appPath: fixture.appPath,
      commandPathOverride: installPath,
      windowsEnvironment: { LOCALAPPDATA: join(fixture.root, 'Local App Data') },
      userPathReader: async () => userPathRead('%localappdata%\\Orca\\bin\\', true),
      userPathWriter
    })

    await expect(installer.install()).resolves.toMatchObject({
      state: 'installed',
      pathConfigured: true
    })
    expect(userPathWriter).not.toHaveBeenCalled()
  })

  it('does not expand environment variables stored in a REG_SZ Windows PATH', async () => {
    const fixture = await makeFixture()
    const installPath = join(fixture.root, 'Local App Data', 'Orca', 'bin', 'orca.cmd')
    const pathDirectory = dirname(installPath)
    const userPathWriter = vi.fn()
    const installer = new CliInstaller({
      platform: 'win32',
      isPackaged: false,
      userDataPath: fixture.userDataPath,
      execPath: 'C:\\Users\\me\\AppData\\Local\\Orca\\Orca.exe',
      appPath: fixture.appPath,
      commandPathOverride: installPath,
      windowsEnvironment: { LOCALAPPDATA: join(fixture.root, 'Local App Data') },
      userPathReader: async () => userPathRead('%LOCALAPPDATA%\\Orca\\bin'),
      userPathWriter
    })

    await installer.install()

    expect(userPathWriter).toHaveBeenCalledWith(`%LOCALAPPDATA%\\Orca\\bin;${pathDirectory}`)
  })

  it('keeps a bundled Windows launcher installed when the user PATH read is unknown', async () => {
    const fixture = await makeFixture()
    const resourcesPath = join(fixture.root, 'resources')
    const bundledLauncher = join(resourcesPath, 'bin', 'orca.exe')
    await mkdir(dirname(bundledLauncher), { recursive: true })
    await writeFile(bundledLauncher, 'native launcher', 'utf8')

    const installer = new CliInstaller({
      platform: 'win32',
      isPackaged: true,
      resourcesPath,
      userDataPath: fixture.userDataPath,
      execPath: join(fixture.root, 'Orca.exe'),
      appPath: fixture.appPath,
      userPathReader: async () => ({
        state: 'unknown',
        detail: 'Orca could not read the Windows user PATH registry value.'
      })
    })

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'installed',
      pathConfigured: null,
      detail: expect.stringContaining('could not read')
    })
  })

  it('does not overwrite the packaged Windows launcher while registering PATH', async () => {
    const fixture = await makeFixture()
    const localAppDataPath = join(fixture.root, 'AppData', 'Local')
    const resourcesPath = join(fixture.root, 'D Custom Orca', 'resources')
    const bundledLauncher = join(resourcesPath, 'bin', 'orca.exe')
    const bundledContent = 'native launcher'
    await mkdir(dirname(bundledLauncher), { recursive: true })
    await writeFile(bundledLauncher, bundledContent, 'utf8')

    let userPath: string | null = null
    const installer = new CliInstaller({
      platform: 'win32',
      isPackaged: true,
      resourcesPath,
      localAppDataPath,
      userDataPath: fixture.userDataPath,
      execPath: join(fixture.root, 'D Custom Orca', 'Orca.exe'),
      appPath: fixture.appPath,
      userPathReader: async () => userPathRead(userPath),
      userPathWriter: async (value) => {
        userPath = value
      }
    })

    const installed = await installer.install()

    expect(installed.state).toBe('installed')
    expect(installed.pathConfigured).toBe(true)
    expect(installed.commandPath).toBe(bundledLauncher)
    expect(userPath).toBe(dirname(bundledLauncher))
    await expect(readFile(bundledLauncher, 'utf8')).resolves.toBe(bundledContent)

    const removed = await installer.remove()

    expect(removed.state).toBe('not_installed')
    expect(removed.pathConfigured).toBe(false)
    expect(userPath).toBe('')
    await expect(readFile(bundledLauncher, 'utf8')).resolves.toBe(bundledContent)
  })
})
