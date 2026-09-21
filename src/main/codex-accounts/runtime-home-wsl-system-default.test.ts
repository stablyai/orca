import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as CodexConfigMirror from '../codex/codex-config-mirror'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
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

  it('reads WSL system-default rate limits from the live system home without materializing', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const store = createStore(
      createSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
      const expectedHome = join(wslHome, '.codex')

      expect(service.prepareForRateLimitFetch(target)).toEqual({
        kind: 'ready',
        codexHomePath: expectedHome
      })
      expect(service.prepareForRateLimitFetch(target)).toEqual({
        kind: 'ready',
        codexHomePath: expectedHome
      })
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('uses the default distro selection for WSL-default rate-limit fetches', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const ubuntuAuth = createCodexAuthJson('ubuntu@example.com', 'acct-ubuntu', 'ubuntu-token')
    const debianAuth = createCodexAuthJson('debian@example.com', 'acct-debian', 'debian-token')
    const ubuntuHomePath = createManagedAuth(testState.userDataDir, 'ubuntu-account', ubuntuAuth)
    const debianHomePath = createManagedAuth(testState.userDataDir, 'debian-account', debianAuth)
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'ubuntu-account',
            email: 'ubuntu@example.com',
            managedHomePath: ubuntuHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Ubuntu',
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/ubuntu/home',
            providerAccountId: 'acct-ubuntu',
            workspaceLabel: null,
            workspaceAccountId: 'acct-ubuntu',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          },
          {
            id: 'debian-account',
            email: 'debian@example.com',
            managedHomePath: debianHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Debian',
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/debian/home',
            providerAccountId: 'acct-debian',
            workspaceLabel: null,
            workspaceAccountId: 'acct-debian',
            createdAt: 2,
            updatedAt: 2,
            lastAuthenticatedAt: 2
          }
        ],
        activeCodexManagedAccountIdsByRuntime: {
          host: null,
          wsl: { Ubuntu: 'ubuntu-account', Debian: 'debian-account' }
        }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      expect(service.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: null })).toEqual({
        kind: 'ready',
        codexHomePath: ubuntuHomePath
      })
      expect(readFileSync(join(ubuntuHomePath, 'auth.json'), 'utf-8')).toBe(ubuntuAuth)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('does not write WSL system-default auth into managed accounts', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
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
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
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

  it('keeps WSL system-default token refreshes in its direct home', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
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
    mkdirSync(systemCodexHomePath, { recursive: true })
    writeFileSync(join(systemCodexHomePath, 'auth.json'), systemAuth, 'utf-8')
    const store = createStore(
      createSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
      expect(service.prepareForCodexLaunch(target)).toBe(systemCodexHomePath)
      writeFileSync(join(systemCodexHomePath, 'auth.json'), refreshedAuth, 'utf-8')

      expect(service.prepareForCodexLaunch(target)).toBe(systemCodexHomePath)
      expect(readFileSync(join(systemCodexHomePath, 'auth.json'), 'utf-8')).toBe(refreshedAuth)
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
    vi.doMock('../wsl', () => ({
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
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
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

  it('passes the Linux source config directory for mounted-drive WSL homes', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => 'C:\\Users\\alice'
    }))
    const syncConfig = vi.fn()
    vi.doMock('../codex/codex-config-mirror', async () => ({
      ...(await vi.importActual<typeof CodexConfigMirror>('../codex/codex-config-mirror')),
      syncSystemConfigIntoManagedCodexHome: syncConfig
    }))

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(createStore(createSettings()) as never)
      const syncWslConfig = (
        service as unknown as {
          syncWslConfigAndGlobalInstructionsForLaunch: (
            target: { runtime: 'wsl'; wslDistro?: string | null },
            runtimeHomePath: string | null
          ) => void
        }
      ).syncWslConfigAndGlobalInstructionsForLaunch

      syncWslConfig.call(
        service,
        { runtime: 'wsl', wslDistro: 'Ubuntu' },
        join(testState.userDataDir, 'runtime-home')
      )

      expect(syncConfig).toHaveBeenCalledWith({
        runtimeHomePath: join(testState.userDataDir, 'runtime-home'),
        systemHomePath: '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\alice\\.codex',
        systemConfigDir: '/mnt/c/Users/alice/.codex'
      })
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })
})
