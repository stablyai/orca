import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CliInstaller } from '../cli-installer'
import { DEV_COMMAND_NAME } from './cli-install-constants'

afterEach(() => {
  vi.unstubAllEnvs()
})

it('falls back to home AppData\\Local when LOCALAPPDATA is blank on Windows', async () => {
  vi.stubEnv('LOCALAPPDATA', '   ')
  vi.stubEnv('ORCA_CLI_INSTALL_PATH', '')
  const homePath = join('C:', 'Users', 'tester')

  const installer = new CliInstaller({
    platform: 'win32',
    isPackaged: false,
    homePath,
    userDataPath: join(homePath, 'user-data'),
    resourcesPath: join(homePath, 'resources'),
    execPath: join(homePath, 'electron.exe'),
    appPath: join(homePath, 'app'),
    commandPathOverride: null,
    userPathReader: async () => ({ status: 'missing' as const, value: '' })
  })

  const status = await installer.getStatus()

  expect(status.commandPath).toBe(
    join(homePath, 'AppData', 'Local', 'Programs', 'Orca Dev', 'bin', `${DEV_COMMAND_NAME}.cmd`)
  )
})
