import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { prepareAntigravityAccountForLaunch } from './native-account-launch'
import { createEncryptedAntigravityAccountStore } from './native-account-store'
import { prepareAntigravityAccountTargetForLaunch } from './native-account-host'

const { prepareForLaunch } = vi.hoisted(() => ({ prepareForLaunch: vi.fn() }))
vi.mock('node:fs', () => ({ existsSync: vi.fn() }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/task/home' })
}))
vi.mock('./native-account-store', () => ({ createEncryptedAntigravityAccountStore: vi.fn() }))
vi.mock('./native-account-host', () => ({
  getAntigravityAccountVaultPath: () => '/task/vault',
  getAntigravityWslAccountVaultRoot: () => '/task/wsl-vault',
  prepareAntigravityAccountTargetForLaunch: vi.fn(async () => {
    await prepareForLaunch()
    return null
  })
}))

beforeEach(() => {
  vi.mocked(existsSync).mockReset().mockReturnValue(true)
  vi.mocked(prepareAntigravityAccountTargetForLaunch)
    .mockReset()
    .mockImplementation(async (_target, _operation, validate) => {
      validate?.()
      await prepareForLaunch()
      return null
    })
  vi.mocked(createEncryptedAntigravityAccountStore).mockReturnValue({
    read: () => ({ accounts: [], selectedAccountId: 'selected' }),
    write: vi.fn()
  })
  prepareForLaunch.mockReset().mockResolvedValue(undefined)
})

describe('native account verification before agy launch', () => {
  it('checks the selected native account before a new host agy launch', async () => {
    await prepareAntigravityAccountForLaunch({
      launchAgent: 'antigravity',
      env: { HOME: '/task/home' }
    })
    expect(prepareForLaunch).toHaveBeenCalledOnce()
  })

  it('recognizes the ordinary agy executable through the shared command recognizer', async () => {
    await prepareAntigravityAccountForLaunch({
      command: 'agy --conversation synthetic',
      env: { HOME: '/task/home' }
    })
    expect(prepareForLaunch).toHaveBeenCalledOnce()
  })

  it('preserves owning-host and distro boundaries without reading client credentials', async () => {
    await prepareAntigravityAccountForLaunch({
      launchAgent: 'antigravity',
      connectionId: 'ssh-owner'
    })
    await prepareAntigravityAccountForLaunch({ launchAgent: 'codex' })
    expect(existsSync).not.toHaveBeenCalled()
    expect(prepareAntigravityAccountTargetForLaunch).not.toHaveBeenCalled()
  })

  it('does not read native credentials when no account selection exists', async () => {
    vi.mocked(existsSync).mockReturnValue(false)
    await prepareAntigravityAccountForLaunch({ launchAgent: 'antigravity' })
    expect(prepareAntigravityAccountTargetForLaunch).not.toHaveBeenCalled()
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

  it('propagates failed native identity verification so the PTY cannot launch as another account', async () => {
    prepareForLaunch.mockRejectedValue(new Error('native identity changed'))
    await expect(
      prepareAntigravityAccountForLaunch({
        launchAgent: 'antigravity',
        env: { HOME: '/task/home' }
      })
    ).rejects.toThrow('native identity changed')
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

afterEach(() => vi.restoreAllMocks())
it('resolves and returns the concrete WSL launch authority without comparing Windows HOME', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.mocked(prepareAntigravityAccountTargetForLaunch).mockResolvedValueOnce({
    distro: 'Ubuntu-24.04',
    uid: 1000,
    home: '/home/u',
    canonicalHome: '/home/u',
    authorityId: 'a'.repeat(64),
    credentialPath: '/home/u/token'
  })
  expect(
    await prepareAntigravityAccountForLaunch({
      launchAgent: 'antigravity',
      isWsl: true,
      wslDistro: null,
      env: { HOME: 'C:\\Users\\u' },
      envIsComplete: true
    })
  ).toEqual({ wslDistro: 'Ubuntu-24.04', authorityId: 'a'.repeat(64) })
  expect(prepareAntigravityAccountTargetForLaunch).toHaveBeenCalledWith(
    { runtime: 'wsl', wslDistro: null },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
    expect.any(Function)
  )
})
it('does not access WSL when no WSL snapshots have ever been stored', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.mocked(existsSync).mockReturnValue(false)
  await prepareAntigravityAccountForLaunch({
    launchAgent: 'antigravity',
    isWsl: true,
    wslDistro: 'Ubuntu'
  })
  expect(prepareAntigravityAccountTargetForLaunch).not.toHaveBeenCalled()
})
it.each([
  { env: { WSLENV: 'HOME/u', HOME: '/other' } },
  { command: 'HOME=/other agy' },
  { command: 'sudo -u other agy' }
])('refuses a WSL startup override whose authority cannot be verified (%j)', async (override) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  await expect(
    prepareAntigravityAccountForLaunch({ launchAgent: 'antigravity', isWsl: true, ...override })
  ).rejects.toThrow('credential authority')
  expect(prepareForLaunch).not.toHaveBeenCalled()
})

it.each(['agy; HOME=/other agy', 'agy $(HOME=/other agy)', 'agy && sudo agy'])(
  'rejects executable shell syntax in a selected WSL launch: %s',
  async (command) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await expect(
      prepareAntigravityAccountForLaunch({ launchAgent: 'antigravity', isWsl: true, command })
    ).rejects.toThrow('credential authority')
    expect(prepareForLaunch).not.toHaveBeenCalled()
  }
)

it.each([
  'ORCA_ORIG_ZDOTDIR',
  'ZDOTDIR',
  'ORCA_ZSHENV_SOURCE_DIR',
  'BASH_ENV',
  'ENV',
  'XDG_CONFIG_HOME'
])('rejects transported shell configuration that can change guest HOME: %s', async (key) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  await expect(
    prepareAntigravityAccountForLaunch({
      launchAgent: 'antigravity',
      isWsl: true,
      command: 'agy',
      envIsComplete: true,
      env: { WSLENV: `${key}/u`, [key]: '/other-config' }
    })
  ).rejects.toThrow('credential authority')
  expect(prepareForLaunch).not.toHaveBeenCalled()
})
