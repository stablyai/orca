import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from '../runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from '../runtime-home-service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

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

  it('does not write WSL system-default auth into managed accounts', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../../../wsl/discovery/distro-catalog', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const managedAuth = createCodexAuthJson('wsl@example.com', 'acct-wsl', 'managed-old', 1_000)
    const systemDefaultAuth = createCodexAuthJson(
      'wsl@example.com',
      'acct-wsl',
      'system-newer',
      2_000
    )
    const managedHomePath = createManagedAuth(testState.userDataDir, 'wsl-account', managedAuth)
    const systemCodexHomePath = join(wslHome, '.codex')
    mkdirSync(systemCodexHomePath, { recursive: true })
    writeFileSync(join(systemCodexHomePath, 'auth.json'), systemDefaultAuth, 'utf-8')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'wsl-account',
            email: 'wsl@example.com',
            managedHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Ubuntu',
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/wsl-account/home',
            providerAccountId: 'acct-wsl',
            workspaceLabel: null,
            workspaceAccountId: 'acct-wsl',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      expect(service.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toEqual({
        kind: 'ready',
        codexHomePath: systemCodexHomePath
      })
      expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(managedAuth)
      const externallyRefreshedAuth = createCodexAuthJson(
        'wsl@example.com',
        'acct-wsl',
        'system-refreshed',
        3_000
      )
      writeFileSync(join(systemCodexHomePath, 'auth.json'), externallyRefreshedAuth, 'utf-8')
      expect(service.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toEqual({
        kind: 'ready',
        codexHomePath: systemCodexHomePath
      })
      expect(readFileSync(join(systemCodexHomePath, 'auth.json'), 'utf-8')).toBe(
        externallyRefreshedAuth
      )
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('does not overwrite direct WSL system auth from the retired runtime on restart', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../../../wsl/discovery/distro-catalog', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const systemAuth = createCodexAuthJson('wsl@example.com', 'acct-wsl', 'system-old', 1_000)
    const refreshedAuth = createCodexAuthJson(
      'wsl@example.com',
      'acct-wsl',
      'runtime-refreshed',
      2_000
    )
    const systemCodexHomePath = join(wslHome, '.codex')
    const wslRuntimeHomePath = join(
      wslHome,
      '.local',
      'share',
      'orca',
      'codex-runtime-home',
      'home'
    )
    mkdirSync(systemCodexHomePath, { recursive: true })
    mkdirSync(wslRuntimeHomePath, { recursive: true })
    writeFileSync(join(systemCodexHomePath, 'auth.json'), systemAuth, 'utf-8')
    writeFileSync(join(wslRuntimeHomePath, 'auth.json'), refreshedAuth, 'utf-8')
    const store = createStore(
      createSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }

      expect(service.prepareForCodexLaunch(target)).toBe(systemCodexHomePath)
      expect(readFileSync(join(systemCodexHomePath, 'auth.json'), 'utf-8')).toBe(systemAuth)
      expect(readFileSync(join(wslRuntimeHomePath, 'auth.json'), 'utf-8')).toBe(refreshedAuth)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })
})
