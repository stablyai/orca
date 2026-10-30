import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { prepareAntigravityAccountForLaunch } from './native-account-launch'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { getAntigravityAccountService } from './native-account-host'

const { prepareForLaunch } = vi.hoisted(() => ({ prepareForLaunch: vi.fn() }))
vi.mock('node:fs', () => ({ existsSync: vi.fn(), readFileSync: vi.fn(() => '') }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/task/home' })
}))
vi.mock('./native-account-store', () => ({ createEncryptedAntigravityAccountStore: vi.fn() }))
vi.mock('./native-account-host', () => ({
  getAntigravityAccountVaultPath: () => '/task/vault',
  getAntigravityAccountService: vi.fn(() => ({ prepareForLaunch }))
}))

beforeEach(() => {
  vi.mocked(existsSync).mockReset().mockReturnValue(true)
  vi.mocked(getAntigravityAccountService).mockClear()
  vi.mocked(createEncryptedAntigravityAccountStore)
    .mockReset()
    .mockReturnValue({
      read: () => ({ accounts: [], selectedAccountId: 'selected' }),
      write: vi.fn()
    })
  prepareForLaunch.mockReset().mockResolvedValue(undefined)
})

describe('native account verification before agy launch', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  })

  it('retains non-Windows delegation and propagates native mismatch refusal', async () => {
    prepareForLaunch.mockRejectedValueOnce(new Error('native account changed'))
    await expect(
      prepareAntigravityAccountForLaunch({
        command: 'agy',
        env: { HOME: '/task/home' },
        envIsComplete: true
      })
    ).rejects.toThrow('native account changed')
    await prepareAntigravityAccountForLaunch({
      command: 'agy',
      env: { HOME: '/task/home' },
      envIsComplete: true
    })
    expect(prepareForLaunch).toHaveBeenCalledTimes(2)
  })
  it('preserves owning-host and distro boundaries without reading client credentials', async () => {
    await prepareAntigravityAccountForLaunch({
      launchAgent: 'antigravity',
      connectionId: 'ssh-owner'
    })
    await prepareAntigravityAccountForLaunch({ launchAgent: 'antigravity', isWsl: true })
    await prepareAntigravityAccountForLaunch({ launchAgent: 'codex' })
    expect(existsSync).not.toHaveBeenCalled()
    expect(getAntigravityAccountService).not.toHaveBeenCalled()
  })

  it('does not read native credentials when no account selection exists', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    await prepareAntigravityAccountForLaunch({ launchAgent: 'antigravity' })
    expect(getAntigravityAccountService).not.toHaveBeenCalled()
  })

  it('blocks a launch using an overridden credential home without silently replacing its account', async () => {
    await expect(
      prepareAntigravityAccountForLaunch({
        launchAgent: 'antigravity',
        env: { HOME: '/other/authority' }
      })
    ).rejects.toThrow('different credential authority')
    expect(prepareForLaunch).not.toHaveBeenCalled()
  })

  it('rejects deleting the credential home before launch', async () => {
    await expect(
      prepareAntigravityAccountForLaunch({ launchAgent: 'antigravity', envToDelete: ['HOME'] })
    ).rejects.toThrow('different credential authority')
    expect(prepareForLaunch).not.toHaveBeenCalled()
  })

  it('does not merge removed authority detectors back into a complete launch environment', async () => {
    vi.stubEnv('SSH_CLIENT', 'task-host')
    try {
      await expect(
        prepareAntigravityAccountForLaunch({
          launchAgent: 'antigravity',
          env: { HOME: '/task/home' },
          envIsComplete: true
        })
      ).rejects.toThrow('different credential authority')
      expect(prepareForLaunch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Windows launch ownership', () => {
  it('returns before observing command, environment, vault or native account', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await prepareAntigravityAccountForLaunch({
      get command(): string {
        throw new Error('command interpretation')
      },
      get env(): NodeJS.ProcessEnv {
        throw new Error('environment interpretation')
      }
    })
    expect(existsSync).not.toHaveBeenCalled()
    expect(createEncryptedAntigravityAccountStore).not.toHaveBeenCalled()
    expect(getAntigravityAccountService).not.toHaveBeenCalled()
  })
})
