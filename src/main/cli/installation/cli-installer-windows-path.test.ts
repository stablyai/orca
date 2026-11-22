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

import { CliInstaller } from '../cli-installer'
import {
  WindowsUserPathRegistryReader,
  type WindowsUserPathReadResult
} from '../command-paths/windows-user-path-registry'
import { makeFixture } from './cli-installer-test-fixtures'

function userPathRead(value: string | null, expandable = false): WindowsUserPathReadResult {
  return { state: 'success', value, expandable }
}

describe('CliInstaller', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
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
