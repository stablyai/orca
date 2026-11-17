import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  hasSecretService: vi.fn(async (_env?: NodeJS.ProcessEnv) => false),
  isContainerOrWsl: vi.fn(() => false),
  prepareForLaunch: vi.fn(async () => {}),
  homeDir: '',
  vaultPath: ''
}))

vi.mock('../../shared/app-lifecycle/app-environment', () => ({
  getAppEnvironment: () => ({
    getPath: (name: string) => (name === 'home' ? mocks.homeDir : mocks.homeDir)
  })
}))

vi.mock('./native-account-store', () => ({
  createEncryptedAntigravityAccountStore: () => ({
    read: () => ({ accounts: [], selectedAccountId: 'acc-1' }),
    write: () => {}
  })
}))

vi.mock('./native-account-host', () => ({
  getAntigravityAccountVaultPath: () => mocks.vaultPath,
  getAntigravityAccountService: async () => ({
    prepareForLaunch: mocks.prepareForLaunch
  })
}))

vi.mock('./native-linux-credentials', () => ({
  readAntigravityLinuxCredential: vi.fn(async () => null),
  writeAntigravityLinuxCredential: vi.fn(),
  hasAntigravityLinuxSecretService: (env?: NodeJS.ProcessEnv) => mocks.hasSecretService(env)
}))

import type * as NativeFileCredentials from './native-file-credentials'

vi.mock('./native-file-credentials', async (importActual) => {
  const actual = await importActual<typeof NativeFileCredentials>()
  return {
    ...actual,
    isAntigravityContainerOrWslHost: () => mocks.isContainerOrWsl()
  }
})

import { prepareAntigravityAccountForLaunch } from './native-account-launch'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'

describe('prepareAntigravityAccountForLaunch', () => {
  let tempDir: string
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-agy-launch-auth-'))
    mocks.homeDir = tempDir
    mocks.vaultPath = join(tempDir, 'vault')
    writeFileSync(mocks.vaultPath, '{}')
    originalEnv = process.env
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    mocks.hasSecretService.mockReset()
    mocks.isContainerOrWsl.mockReset().mockReturnValue(false)
    mocks.prepareForLaunch.mockReset()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('allows headless Linux SSH launch when daemon bus lacks Secret Service', async () => {
    process.env = { HOME: tempDir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }
    mocks.hasSecretService.mockResolvedValue(false)

    await prepareAntigravityAccountForLaunch({
      launchAgent: 'antigravity',
      env: { HOME: tempDir, SSH_CONNECTION: '1.2.3.4 1234 5.6.7.8 22' }
    })

    expect(mocks.prepareForLaunch).toHaveBeenCalledTimes(1)
  })

  it('still rejects when daemon process reaches Secret Service while SSH launch uses file storage', async () => {
    process.env = { HOME: tempDir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }
    mocks.hasSecretService.mockImplementation(
      async (env?: NodeJS.ProcessEnv) => !env?.SSH_CONNECTION
    )

    await expect(
      prepareAntigravityAccountForLaunch({
        launchAgent: 'antigravity',
        env: { HOME: tempDir, SSH_CONNECTION: '1.2.3.4 1234 5.6.7.8 22' }
      })
    ).rejects.toThrow('different credential authority')

    expect(mocks.prepareForLaunch).not.toHaveBeenCalled()
  })

  it('uses file credential authority on container or WSL hosts without probing Secret Service', async () => {
    process.env = { HOME: tempDir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }
    mocks.isContainerOrWsl.mockReturnValue(true)

    await prepareAntigravityAccountForLaunch({
      launchAgent: 'antigravity',
      env: { HOME: tempDir, SSH_CONNECTION: '1.2.3.4 1234 5.6.7.8 22' }
    })

    expect(mocks.hasSecretService).not.toHaveBeenCalled()
    expect(mocks.prepareForLaunch).toHaveBeenCalledTimes(1)
  })

  it('keeps host agy loginCommand separated from managed Antigravity runtime spec', () => {
    expect(ANTIGRAVITY_LAUNCH_SPEC.loginCommand).toEqual([])
    expect(ANTIGRAVITY_LAUNCH_SPEC.hostBackend?.spec.loginCommand).toEqual([
      'agy',
      'acp',
      '--login'
    ])
  })
})
