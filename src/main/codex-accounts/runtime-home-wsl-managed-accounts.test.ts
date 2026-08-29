import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it('does not touch host auth on startup when the active account is WSL-backed', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
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
        wslRuntimeHomePath
      )
      expect(readFileSync(join(wslRuntimeHomePath, 'auth.json'), 'utf-8')).toBe(
        '{"account":"wsl"}\n'
      )
      expect(service.prepareForRateLimitFetch()).toEqual({
        kind: 'ready',
        codexHomePath: getRuntimeCodexHomePath()
      })
      expect(service.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toEqual({
        kind: 'ready',
        codexHomePath: wslRuntimeHomePath
      })
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('clears a selected WSL managed account when auth.json is missing', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system-token')
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('wsl@example.com', 'acct-wsl', 'managed-token')
    )
    rmSync(join(managedHomePath, 'auth.json'), { force: true })
    const systemCodexHomePath = join(wslHome, '.codex')
    mkdirSync(systemCodexHomePath, { recursive: true })
    writeFileSync(join(systemCodexHomePath, 'auth.json'), systemAuth, 'utf-8')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'wsl@example.com',
            managedHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Ubuntu',
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/account-1/home',
            providerAccountId: 'acct-wsl',
            workspaceLabel: null,
            workspaceAccountId: 'acct-wsl',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-1' } }
      })
    )

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
        wslRuntimeHomePath
      )
      expect(store.updateSettings).toHaveBeenCalledWith({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
      expect(readFileSync(join(wslRuntimeHomePath, 'auth.json'), 'utf-8')).toBe(systemAuth)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('seeds the WSL runtime config with rewritten paths and no system hook trust', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
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
        wslRuntimeHomePath
      )
      const runtimeConfigPath = join(wslRuntimeHomePath, 'config.toml')
      const runtimeConfig = readFileSync(runtimeConfigPath, 'utf-8')
      expect(runtimeConfig).toContain(
        `model_instructions_file = '${join(systemCodexHomePath, 'instructions.md')}'`
      )
      expect(runtimeConfig).toContain('[projects."/home/alice/repo"]')
      expect(runtimeConfig).not.toContain('[hooks.state.')

      // Why: WSL runtime configs are seeded once; Codex writes trust into them
      // afterwards, so a relaunch must not clobber the seeded file.
      writeFileSync(runtimeConfigPath, `${runtimeConfig}\n[projects."/tmp/x"]\n`, 'utf-8')
      service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      expect(readFileSync(runtimeConfigPath, 'utf-8')).toContain('[projects."/tmp/x"]')
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('anchors WSL seed rewrites to the Linux-side home parsed from the UNC source', async () => {
    const { prepareWslRuntimeSeedConfig } = await import('./runtime-home-service')

    // Why: real UNC sources cannot back live fs operations in tests, so pin
    // the UNC -> Linux-side anchor translation on the extracted seed function.
    expect(
      prepareWslRuntimeSeedConfig(
        'model_instructions_file = "instructions.md"\n',
        '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.codex'
      )
    ).toContain("model_instructions_file = '/home/alice/.codex/instructions.md'")
    expect(
      prepareWslRuntimeSeedConfig(
        'model_instructions_file = "instructions.md"\n',
        '\\\\wsl$\\Ubuntu\\home\\alice\\.codex'
      )
    ).toContain("model_instructions_file = '/home/alice/.codex/instructions.md'")
  })

  it('switches WSL accounts by rewriting one stable WSL runtime home', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
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

      expect(service.prepareForCodexLaunch(target)).toBe(wslRuntimeHomePath)
      expect(readFileSync(join(wslRuntimeHomePath, 'auth.json'), 'utf-8')).toBe(firstAuth)

      store.updateSettings({
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-2' } }
      })
      service.syncForCurrentSelection(target)

      expect(service.prepareForCodexLaunch(target)).toBe(wslRuntimeHomePath)
      expect(readFileSync(join(wslRuntimeHomePath, 'auth.json'), 'utf-8')).toBe(secondAuth)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('does not use host auth baseline to accept stale WSL runtime auth', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const hostAuth = createCodexAuthJson('host@example.com', 'acct-host', 'host-token')
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
    const hostManagedHomePath = createManagedAuth(testState.userDataDir, 'host-account', hostAuth)
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
            id: 'host-account',
            email: 'host@example.com',
            managedHomePath: hostManagedHomePath,
            providerAccountId: 'acct-host',
            workspaceLabel: null,
            workspaceAccountId: 'acct-host',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          },
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
            createdAt: 2,
            updatedAt: 2,
            lastAuthenticatedAt: 2
          }
        ],
        activeCodexManagedAccountId: 'host-account',
        activeCodexManagedAccountIdsByRuntime: {
          host: 'host-account',
          wsl: { Ubuntu: 'wsl-account' }
        }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        wslRuntimeHomePath
      )
      expect(readFileSync(join(wslManagedHomePath, 'auth.json'), 'utf-8')).toBe(wslManagedAuth)
      expect(readFileSync(join(wslRuntimeHomePath, 'auth.json'), 'utf-8')).toBe(wslManagedAuth)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('does not clobber fresh WSL tokens after clearLastWrittenAuthJson', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
    const originalAuth = createCodexAuthJson('wsl@example.com', 'acct-wsl', 'original', 1_000)
    const staleRuntimeAuth = createCodexAuthJson('wsl@example.com', 'acct-wsl', 'stale', 1_500)
    const reauthedAuth = createCodexAuthJson('wsl@example.com', 'acct-wsl', 'reauthed', 2_000)
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', originalAuth)
    const managedAuthPath = join(managedHomePath, 'auth.json')
    const wslRuntimeHomePath = join(
      wslHome,
      '.local',
      'share',
      'orca',
      'codex-runtime-home',
      'home'
    )
    const runtimeAuthPath = join(wslRuntimeHomePath, 'auth.json')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'wsl@example.com',
            managedHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Ubuntu',
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/account-1/home',
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
          wsl: { Ubuntu: 'account-1' }
        }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      expect(service.prepareForCodexLaunch(target)).toBe(wslRuntimeHomePath)
      writeFileSync(runtimeAuthPath, staleRuntimeAuth, 'utf-8')
      writeFileSync(managedAuthPath, reauthedAuth, 'utf-8')

      service.clearLastWrittenAuthJson('account-1')
      service.syncForCurrentSelection(target)

      expect(readFileSync(managedAuthPath, 'utf-8')).toBe(reauthedAuth)
      expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(reauthedAuth)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('reads active WSL token refreshes back before restart using the selected distro', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const managedAuth = createCodexAuthJson('wsl@example.com', 'acct-wsl', 'managed', 1_000)
    const refreshedAuth = createCodexAuthJson(
      'wsl@example.com',
      'acct-wsl',
      'runtime-refreshed',
      2_000
    )
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    const managedAuthPath = join(managedHomePath, 'auth.json')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'wsl@example.com',
            managedHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: null,
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/account-1/home',
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
          wsl: { Ubuntu: 'account-1' }
        }
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
      const runtimeAuthPath = join(wslRuntimeHomePath, 'auth.json')

      expect(service.prepareForCodexLaunch(target)).toBe(wslRuntimeHomePath)
      writeFileSync(runtimeAuthPath, refreshedAuth, 'utf-8')

      service.syncActiveWslSelectionsBeforeRestart()

      expect(readFileSync(managedAuthPath, 'utf-8')).toBe(refreshedAuth)
      expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(refreshedAuth)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })
})
