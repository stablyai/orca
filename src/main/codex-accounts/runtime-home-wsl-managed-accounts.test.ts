import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  getRuntimeCodexHomePath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

// These launches are the user's own, so the E9 exec gate lets their prep run.
vi.mock('../wsl/discovery/wsl-background-exec-gate', () => ({
  blockedWslDistroForExec: async () => null
}))
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

  it('does not touch host auth on startup when the active account is WSL-backed', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl/discovery/distro-catalog', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome,
      getWslHomeAsync: async () => wslHome
    }))
    const runtimeAuthPath = join(testState.fakeHomeDir, '.codex', 'auth.json')
    writeFileSync(runtimeAuthPath, '{"account":"host-system"}\n', 'utf-8')
    const wslManagedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      '{"account":"wsl"}\n'
    )
    const settings = createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath: wslManagedHomePath,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/account-1/home',
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: null,
      activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-1' } }
    })
    const store = createStore(settings)

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const wslRuntimeHomePath = join(
        wslHome,
        '.local',
        'share',
        'orca',
        'codex-runtime-home',
        'home'
      )

      expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe('{"account":"host-system"}\n')
      expect(service.prepareForCodexLaunch()).toBe(getRuntimeCodexHomePath())
      expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        wslManagedHomePath
      )
      expect(existsSync(join(wslRuntimeHomePath, 'auth.json'))).toBe(false)
      expect(service.prepareForRateLimitFetch()).toEqual({
        kind: 'ready',
        codexHomePath: getRuntimeCodexHomePath()
      })
      expect(service.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toEqual({
        kind: 'ready',
        codexHomePath: wslManagedHomePath
      })
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('launches WSL system default against its existing config without a runtime seed', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl/discovery/distro-catalog', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome,
      getWslHomeAsync: async () => wslHome
    }))
    const systemCodexHomePath = join(wslHome, '.codex')
    mkdirSync(systemCodexHomePath, { recursive: true })
    writeFileSync(
      join(systemCodexHomePath, 'config.toml'),
      [
        'model_instructions_file = "instructions.md"',
        '',
        '[hooks.state."system-hooks:stop:0:0"]',
        'enabled = true',
        '',
        '[projects."/home/alice/repo"]',
        'trust_level = "trusted"',
        ''
      ].join('\n'),
      'utf-8'
    )
    const store = createStore(createSettings())

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const wslRuntimeHomePath = join(
        wslHome,
        '.local',
        'share',
        'orca',
        'codex-runtime-home',
        'home'
      )

      expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        systemCodexHomePath
      )
      const runtimeConfigPath = join(wslRuntimeHomePath, 'config.toml')
      expect(existsSync(runtimeConfigPath)).toBe(false)
      const systemConfigPath = join(systemCodexHomePath, 'config.toml')
      const systemConfig = readFileSync(systemConfigPath, 'utf-8')
      expect(systemConfig).toContain('model_instructions_file = "instructions.md"')
      expect(systemConfig).toContain('[hooks.state.')

      writeFileSync(systemConfigPath, `${systemConfig}\n[projects."/tmp/x"]\n`, 'utf-8')
      service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      expect(readFileSync(systemConfigPath, 'utf-8')).toContain('[projects."/tmp/x"]')
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('switches WSL accounts by selecting each account home directly', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl/discovery/distro-catalog', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome,
      getWslHomeAsync: async () => wslHome
    }))
    const firstAuth = createCodexAuthJson('first@example.com', 'acct-first', 'first-token')
    const secondAuth = createCodexAuthJson('second@example.com', 'acct-second', 'second-token')
    const firstManagedHomePath = createManagedAuth(testState.userDataDir, 'account-1', firstAuth)
    const secondManagedHomePath = createManagedAuth(testState.userDataDir, 'account-2', secondAuth)
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'first@example.com',
            managedHomePath: firstManagedHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Ubuntu',
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/account-1/home',
            providerAccountId: 'acct-first',
            workspaceLabel: null,
            workspaceAccountId: 'acct-first',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          },
          {
            id: 'account-2',
            email: 'second@example.com',
            managedHomePath: secondManagedHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Ubuntu',
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/account-2/home',
            providerAccountId: 'acct-second',
            workspaceLabel: null,
            workspaceAccountId: 'acct-second',
            createdAt: 2,
            updatedAt: 2,
            lastAuthenticatedAt: 2
          }
        ],
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-1' } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
      const wslRuntimeHomePath = join(
        wslHome,
        '.local',
        'share',
        'orca',
        'codex-runtime-home',
        'home'
      )

      expect(service.prepareForCodexLaunch(target)).toBe(firstManagedHomePath)
      expect(existsSync(join(wslRuntimeHomePath, 'auth.json'))).toBe(false)

      store.updateSettings({
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-2' } }
      })
      service.syncForCurrentSelection(target)

      expect(service.prepareForCodexLaunch(target)).toBe(secondManagedHomePath)
      expect(readFileSync(join(firstManagedHomePath, 'auth.json'), 'utf-8')).toBe(firstAuth)
      expect(readFileSync(join(secondManagedHomePath, 'auth.json'), 'utf-8')).toBe(secondAuth)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('ignores stale retired runtime auth when launching a managed WSL account', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl/discovery/distro-catalog', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome,
      getWslHomeAsync: async () => wslHome
    }))
    const wslManagedAuth = createCodexAuthJson(
      'wsl@example.com',
      'acct-wsl',
      'managed-newer',
      2_000
    )
    const staleWslRuntimeAuth = createCodexAuthJson(
      'wsl@example.com',
      'acct-wsl',
      'runtime-stale',
      1_000
    )
    const wslManagedHomePath = createManagedAuth(
      testState.userDataDir,
      'wsl-account',
      wslManagedAuth
    )
    const wslRuntimeHomePath = join(
      wslHome,
      '.local',
      'share',
      'orca',
      'codex-runtime-home',
      'home'
    )
    mkdirSync(wslRuntimeHomePath, { recursive: true })
    writeFileSync(join(wslRuntimeHomePath, 'auth.json'), staleWslRuntimeAuth, 'utf-8')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'wsl-account',
            email: 'wsl@example.com',
            managedHomePath: wslManagedHomePath,
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
        activeCodexManagedAccountIdsByRuntime: {
          host: null,
          wsl: { Ubuntu: 'wsl-account' }
        }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        wslManagedHomePath
      )
      expect(readFileSync(join(wslManagedHomePath, 'auth.json'), 'utf-8')).toBe(wslManagedAuth)
      expect(readFileSync(join(wslRuntimeHomePath, 'auth.json'), 'utf-8')).toBe(staleWslRuntimeAuth)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })
})
