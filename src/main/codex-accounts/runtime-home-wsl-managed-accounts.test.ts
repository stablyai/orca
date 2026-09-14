import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as CodexConfigMirror from '../codex/codex-config-mirror'
import type * as CodexHomePaths from '../codex/codex-home-paths'
import type * as CodexPaneAccountRegistry from '../codex/codex-pane-account-registry'
import type * as LegacyWslRuntimeAuthDrain from './legacy-wsl-runtime-auth-drain'
import type * as WslCodexAuthBatchReader from './wsl-codex-auth-batch-reader'
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

  it('keeps a selected WSL managed home when auth.json is temporarily missing', async () => {
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
        managedHomePath
      )
      expect(store.updateSettings).not.toHaveBeenCalled()
      expect(existsSync(join(wslRuntimeHomePath, 'auth.json'))).toBe(false)
      expect(readFileSync(join(systemCodexHomePath, 'auth.json'), 'utf-8')).toBe(systemAuth)
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

  it('waits for the legacy drain before completing direct-home launch preparation', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    let finishDrain: (() => void) | undefined
    const startLegacyWslRuntimeAuthDrain = vi.fn(
      (_options: unknown, _startOptions?: { throwOnFailure?: boolean }) =>
        new Promise<void>((resolve) => {
          finishDrain = resolve
        })
    )
    vi.doMock('./legacy-wsl-runtime-auth-drain', () => ({ startLegacyWslRuntimeAuthDrain }))
    const startWslCodexSessionBridgeInBackground = vi.fn(() => Promise.resolve())
    vi.doMock('../codex/wsl-codex-session-bridge', () => ({
      startWslCodexSessionBridgeInBackground
    }))
    vi.doMock('../codex/codex-home-paths', async (importOriginal) => ({
      ...(await importOriginal<typeof CodexHomePaths>()),
      syncCodexGlobalInstructionsIntoManagedHome: vi.fn()
    }))
    vi.doMock('../codex/codex-config-mirror', async (importOriginal) => ({
      ...(await importOriginal<typeof CodexConfigMirror>()),
      syncSystemConfigIntoManagedCodexHome: vi.fn()
    }))
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('wsl@example.com', 'acct-wsl', 'managed-token')
    )
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
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'account-1' } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      const launch = service.prepareForCodexLaunchAsync({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      await Promise.resolve()

      expect(startLegacyWslRuntimeAuthDrain).toHaveBeenCalledTimes(1)
      expect(startLegacyWslRuntimeAuthDrain.mock.calls[0]?.[1]).toEqual({ throwOnFailure: true })
      expect(startWslCodexSessionBridgeInBackground).not.toHaveBeenCalled()

      finishDrain?.()
      await expect(launch).resolves.toBe(managedHomePath)
      expect(startWslCodexSessionBridgeInBackground).toHaveBeenCalledTimes(1)
    } finally {
      vi.doUnmock('../codex/codex-config-mirror')
      vi.doUnmock('../codex/codex-home-paths')
      vi.doUnmock('../codex/wsl-codex-session-bridge')
      vi.doUnmock('./legacy-wsl-runtime-auth-drain')
      vi.doUnmock('../wsl')
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('preserves legacy auth while draining when pane attribution is unavailable', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    vi.doMock('../codex/codex-pane-account-registry', async (importOriginal) => ({
      ...(await importOriginal<typeof CodexPaneAccountRegistry>()),
      hasRecordedLegacyWslCodexPane: () => {
        throw new Error('registry unavailable')
      }
    }))
    const startLegacyWslRuntimeAuthDrain = vi.fn(() => Promise.resolve())
    vi.doMock('./legacy-wsl-runtime-auth-drain', () => ({ startLegacyWslRuntimeAuthDrain }))
    const store = createStore(createSettings())

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      await service.prepareForCodexLaunchAsync({ runtime: 'wsl', wslDistro: 'Ubuntu' })

      expect(startLegacyWslRuntimeAuthDrain).toHaveBeenCalledWith(
        expect.objectContaining({ legacyPanePresent: true }),
        { throwOnFailure: true }
      )
    } finally {
      vi.doUnmock('./legacy-wsl-runtime-auth-drain')
      vi.doUnmock('../codex/codex-pane-account-registry')
      vi.doUnmock('../wsl')
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('ignores stale retired runtime auth when launching a managed WSL account', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
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

  it('launches and drains a mounted-drive WSL account through its distro path', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const managedAuth = createCodexAuthJson(
      'drive@example.com',
      'acct-drive',
      'drive-refresh',
      2_000
    )
    const linuxHomePath = '/mnt/c/Users/alice/orca/codex-accounts/drive-account/home'
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => 'C:\\Users\\alice'
    }))
    vi.doMock('./wsl-codex-auth-batch-reader', async (importOriginal) => ({
      ...(await importOriginal<typeof WslCodexAuthBatchReader>()),
      readWslCodexAuths: vi.fn(async (_distro: string, homes: string[]) =>
        homes.map((home) =>
          home === linuxHomePath
            ? { kind: 'present' as const, contents: managedAuth }
            : { kind: 'missing' as const }
        )
      )
    }))
    let drainGuestHome: string | null = null
    let drainDestination: { authContents: string; linuxHomePath: string } | null = null
    const drainTasks: Promise<void>[] = []
    vi.doMock('./legacy-wsl-runtime-auth-drain', async (importOriginal) => ({
      ...(await importOriginal<typeof LegacyWslRuntimeAuthDrain>()),
      startLegacyWslRuntimeAuthDrain: (
        options: Parameters<typeof LegacyWslRuntimeAuthDrain.startLegacyWslRuntimeAuthDrain>[0]
      ) => {
        drainGuestHome = options.guestHomeLinuxPath
        const task = Promise.resolve(options.resolveDestination(managedAuth)).then(
          (destination) => {
            drainDestination = destination
          }
        )
        drainTasks.push(task)
        return task
      }
    }))
    const startWslCodexSessionBridgeInBackground = vi.fn(() => Promise.resolve())
    vi.doMock('../codex/wsl-codex-session-bridge', () => ({
      startWslCodexSessionBridgeInBackground,
      syncWslCodexSessionsIntoManagedHome: vi.fn(() => Promise.resolve())
    }))
    vi.doMock('../codex/codex-home-paths', async (importOriginal) => ({
      ...(await importOriginal<typeof CodexHomePaths>()),
      syncCodexGlobalInstructionsIntoManagedHome: vi.fn()
    }))
    vi.doMock('../codex/codex-config-mirror', async (importOriginal) => ({
      ...(await importOriginal<typeof CodexConfigMirror>()),
      syncSystemConfigIntoManagedCodexHome: vi.fn()
    }))
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'drive-account',
            email: 'drive@example.com',
            managedHomePath: 'C:\\Users\\alice\\orca\\codex-accounts\\drive-account\\home',
            managedHomeRuntime: 'wsl',
            wslDistro: 'Ubuntu',
            wslLinuxHomePath: linuxHomePath,
            providerAccountId: 'acct-drive',
            workspaceLabel: null,
            workspaceAccountId: 'acct-drive',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountIdsByRuntime: {
          host: null,
          wsl: { Ubuntu: 'drive-account' }
        }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\alice\\orca\\codex-accounts\\drive-account\\home'
      )
      await Promise.all(drainTasks)

      expect(drainGuestHome).toBe('/mnt/c/Users/alice')
      expect(drainDestination).toEqual({ authContents: managedAuth, linuxHomePath })
      expect(startWslCodexSessionBridgeInBackground).toHaveBeenCalledWith({
        distro: 'Ubuntu',
        systemCodexHomePath: '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\alice\\.codex',
        managedCodexHomePath:
          '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\alice\\orca\\codex-accounts\\drive-account\\home'
      })
    } finally {
      vi.doUnmock('../codex/codex-config-mirror')
      vi.doUnmock('../codex/codex-home-paths')
      vi.doUnmock('../codex/wsl-codex-session-bridge')
      vi.doUnmock('./legacy-wsl-runtime-auth-drain')
      vi.doUnmock('./wsl-codex-auth-batch-reader')
      vi.doUnmock('../wsl')
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('resolves a mounted-drive WSL system home as the legacy drain destination', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const systemAuth = createCodexAuthJson(
      'system@example.com',
      'acct-system',
      'system-refresh',
      2_000
    )
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => 'C:\\Users\\alice'
    }))
    vi.doMock('./wsl-codex-auth-batch-reader', async (importOriginal) => ({
      ...(await importOriginal<typeof WslCodexAuthBatchReader>()),
      readWslCodexAuths: vi.fn(async (_distro: string, homes: string[]) =>
        homes.map((home) =>
          home === '/mnt/c/Users/alice/.codex'
            ? { kind: 'present' as const, contents: systemAuth }
            : { kind: 'missing' as const }
        )
      )
    }))
    let drainDestination: { authContents: string; linuxHomePath: string } | null = null
    const drainTasks: Promise<void>[] = []
    vi.doMock('./legacy-wsl-runtime-auth-drain', async (importOriginal) => ({
      ...(await importOriginal<typeof LegacyWslRuntimeAuthDrain>()),
      startLegacyWslRuntimeAuthDrain: (
        options: Parameters<typeof LegacyWslRuntimeAuthDrain.startLegacyWslRuntimeAuthDrain>[0]
      ) => {
        const task = Promise.resolve(options.resolveDestination(systemAuth)).then((destination) => {
          drainDestination = destination
        })
        drainTasks.push(task)
        return task
      }
    }))
    vi.doMock('../codex/wsl-codex-session-bridge', () => ({
      startWslCodexSessionBridgeInBackground: vi.fn(() => Promise.resolve())
    }))
    vi.doMock('../codex/codex-home-paths', async (importOriginal) => ({
      ...(await importOriginal<typeof CodexHomePaths>()),
      syncCodexGlobalInstructionsIntoManagedHome: vi.fn()
    }))
    vi.doMock('../codex/codex-config-mirror', async (importOriginal) => ({
      ...(await importOriginal<typeof CodexConfigMirror>()),
      syncSystemConfigIntoManagedCodexHome: vi.fn()
    }))
    const store = createStore(
      createSettings({
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe(
        '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\alice\\.codex'
      )
      await Promise.all(drainTasks)
      expect(drainDestination).toEqual({
        authContents: systemAuth,
        linuxHomePath: '/mnt/c/Users/alice/.codex'
      })
    } finally {
      vi.doUnmock('../codex/codex-config-mirror')
      vi.doUnmock('../codex/codex-home-paths')
      vi.doUnmock('../codex/wsl-codex-session-bridge')
      vi.doUnmock('./legacy-wsl-runtime-auth-drain')
      vi.doUnmock('./wsl-codex-auth-batch-reader')
      vi.doUnmock('../wsl')
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })
})
