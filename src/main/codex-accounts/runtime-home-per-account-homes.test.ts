import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  expectResourceLinkedOrCopied,
  getRuntimeCodexAuthPath,
  getSystemCodexAuthPath,
  getSystemCodexHomePath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('CodexRuntimeHomeService', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    teardownRuntimeHomeTest()
  })

  it.each(['two@example.com', 'one@example.com'])(
    'isolates account homes when the second email is %s',
    async (secondEmail) => {
      writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
      const account1Auth = createCodexAuthJson('one@example.com', 'acct-1', 'one')
      const account2Auth = createCodexAuthJson(secondEmail, 'acct-2', 'two')
      const home1 = createManagedAuth(testState.userDataDir, 'account-1', account1Auth)
      const home2 = createManagedAuth(testState.userDataDir, 'account-2', account2Auth)
      const settings = createSettings({
        realHomeRoutable: true,
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'one@example.com',
            managedHomePath: home1,
            providerAccountId: 'acct-1',
            workspaceLabel: null,
            workspaceAccountId: 'acct-1',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          },
          {
            id: 'account-2',
            email: secondEmail,
            managedHomePath: home2,
            providerAccountId: 'acct-2',
            workspaceLabel: null,
            workspaceAccountId: 'acct-2',
            createdAt: 2,
            updatedAt: 2,
            lastAuthenticatedAt: 2
          }
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
      const store = createStore(settings)
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      expect(service.prepareForCodexLaunch()).toBe(home1)
      settings.activeCodexManagedAccountId = 'account-2'
      settings.activeCodexManagedAccountIdsByRuntime = { host: 'account-2', wsl: {} }
      expect(service.prepareForCodexLaunch()).toBe(home2)
      expect(
        service.prepareForCodexLaunch(undefined, undefined, {
          unavailableManagedHomePath: home1
        })
      ).toBe(home2)
      expect(store.updateSettings).not.toHaveBeenCalled()

      expect(readFileSync(join(home1, 'auth.json'), 'utf-8')).toBe(account1Auth)
      expect(readFileSync(join(home2, 'auth.json'), 'utf-8')).toBe(account2Auth)
      expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)
    }
  )

  it('materializes resources and config into the per-account home on launch', async () => {
    writeFileSync(getSystemCodexAuthPath(), '{"account":"system"}\n', 'utf-8')
    mkdirSync(join(getSystemCodexHomePath(), 'skills', 'review'), { recursive: true })
    writeFileSync(
      join(getSystemCodexHomePath(), 'skills', 'review', 'SKILL.md'),
      'skill\n',
      'utf-8'
    )
    writeFileSync(
      join(getSystemCodexHomePath(), 'config.toml'),
      'approval_policy = "never"\n',
      'utf-8'
    )
    const home1 = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('one@example.com', 'acct-1', 'one')
    )
    const store = createStore(
      createSettings({
        realHomeRoutable: true,
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'one@example.com',
            managedHomePath: home1,
            providerAccountId: 'acct-1',
            workspaceLabel: null,
            workspaceAccountId: 'acct-1',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareForCodexLaunch()).toBe(home1)

    expectResourceLinkedOrCopied(join(home1, 'skills'), join(getSystemCodexHomePath(), 'skills'))
    expect(readFileSync(join(home1, 'skills', 'review', 'SKILL.md'), 'utf-8')).toBe('skill\n')
    expect(readFileSync(join(home1, 'config.toml'), 'utf-8')).toContain('approval_policy = "never"')

    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe('{"account":"system"}\n')
  })

  it('does not read shared auth when polling observes a managed-to-real-home transition', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const managedAuth = createCodexAuthJson('user@example.com', 'acct-user', 'managed', 1)
    const refreshedManagedAuth = createCodexAuthJson(
      'user@example.com',
      'acct-user',
      'refreshed',
      2
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    const settings = createSettings({
      realHomeRoutable: true,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: 'acct-user',
          workspaceLabel: null,
          workspaceAccountId: 'acct-user',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    writeFileSync(runtimeAuthPath, refreshedManagedAuth, 'utf-8')
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    const syncSpy = vi.spyOn(service, 'syncForCurrentSelection')

    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: getSystemCodexHomePath()
    })
    expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(managedAuth)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(syncSpy).not.toHaveBeenCalled()

    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: getSystemCodexHomePath()
    })
    expect(service.prepareForCodexLaunch()).toBeNull()
    expect(syncSpy).not.toHaveBeenCalled()
  })
})
