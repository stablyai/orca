import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  prepareAntigravityAccountTargetForLaunch: vi.fn(async () => {
    await prepareForLaunch()
    return null
  })
}))

beforeEach(() => {
  vi.mocked(existsSync).mockReset().mockReturnValue(true)
  vi.mocked(prepareAntigravityAccountTargetForLaunch).mockClear()
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
    await prepareAntigravityAccountForLaunch({ launchAgent: 'antigravity', isWsl: true })
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
