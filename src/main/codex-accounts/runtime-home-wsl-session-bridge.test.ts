import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as WslPaths from '../../shared/wsl-paths'
import type * as CodexConfigMirror from '../codex/codex-config-mirror'
import type * as CodexHomePaths from '../codex/codex-home-paths'
import type * as LegacyWslRuntimeAuthDrain from './legacy-wsl-runtime-auth-drain'
import type * as WslCodexAuthBatchReader from './wsl-codex-auth-batch-reader'
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

  it('skips WSL session bridging when system default already uses its direct home', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const startWslCodexSessionBridgeInBackground = vi.fn(() => Promise.resolve())
    vi.doMock('../codex/wsl-codex-session-bridge', () => ({
      startWslCodexSessionBridgeInBackground
    }))
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const wslSystemHomePath = join(wslHome, '.codex')
    mkdirSync(wslSystemHomePath, { recursive: true })
    writeFileSync(join(wslSystemHomePath, 'AGENTS.md'), '# WSL instructions\n', 'utf-8')
    const store = createStore(
      createSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } }
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
        wslSystemHomePath
      )
      expect(startWslCodexSessionBridgeInBackground).not.toHaveBeenCalled()
      expect(readFileSync(join(wslSystemHomePath, 'AGENTS.md'), 'utf-8')).toBe(
        '# WSL instructions\n'
      )
      expect(existsSync(join(wslRuntimeHomePath, 'AGENTS.md'))).toBe(false)
    } finally {
      vi.doUnmock('../codex/wsl-codex-session-bridge')
      vi.doUnmock('../wsl')
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('keeps WSL in-Codex setting changes in the direct system home', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.doMock('../codex/wsl-codex-session-bridge', () => ({
      startWslCodexSessionBridgeInBackground: vi.fn(() => Promise.resolve())
    }))
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
    const wslSystemConfigPath = join(wslHome, '.codex', 'config.toml')
    mkdirSync(join(wslHome, '.codex'), { recursive: true })
    writeFileSync(wslSystemConfigPath, 'model = "gpt-5"\n', 'utf-8')

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
        join(wslHome, '.codex')
      )
      const baselinePath = join(wslRuntimeHomePath, '.orca-config-settings-baseline.json')
      expect(existsSync(baselinePath)).toBe(false)

      writeFileSync(wslSystemConfigPath, 'model = "outside-edit"\n', 'utf-8')
      service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      expect(readFileSync(wslSystemConfigPath, 'utf-8')).toBe('model = "outside-edit"\n')

      writeFileSync(wslSystemConfigPath, 'model = "o4"\n', 'utf-8')
      service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
      expect(readFileSync(wslSystemConfigPath, 'utf-8')).toBe('model = "o4"\n')
      expect(existsSync(baselinePath)).toBe(false)
    } finally {
      vi.doUnmock('../codex/wsl-codex-session-bridge')
      vi.doUnmock('../wsl')
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('bridges WSL history from a configured per-distro source-home override', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const startWslCodexSessionBridgeInBackground = vi.fn(() => Promise.resolve())
    vi.doMock('../codex/wsl-codex-session-bridge', () => ({
      startWslCodexSessionBridgeInBackground
    }))
    const wslHome = join(testState.userDataDir, 'wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const store = createStore(
      createSettings({
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: null } },
        // Why: the override is a Linux path inside the distro, not <wslHome>/.codex.
        codexSessionSourceHome: { wsl: { Ubuntu: '/home/me/.config/codex' } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)
      service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })

      expect(startWslCodexSessionBridgeInBackground).toHaveBeenCalledTimes(1)
      expect(startWslCodexSessionBridgeInBackground).toHaveBeenCalledWith({
        distro: 'Ubuntu',
        systemCodexHomePath: '/home/me/.config/codex',
        managedCodexHomePath: join(wslHome, '.codex')
      })
    } finally {
      vi.doUnmock('../codex/wsl-codex-session-bridge')
      vi.doUnmock('../wsl')
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('starts WSL session bridging for the selected direct account home', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const startWslCodexSessionBridgeInBackground = vi.fn(() => Promise.resolve())
    vi.doMock('../codex/wsl-codex-session-bridge', () => ({
      startWslCodexSessionBridgeInBackground
    }))
    const wslHome = join(testState.userDataDir, 'debian-wsl-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => null,
      getWslHome: (distro: string) => (distro === 'Debian' ? wslHome : null)
    }))
    vi.doMock('../../shared/wsl-paths', async (importOriginal) => {
      const actual = await importOriginal<typeof WslPaths>()
      return {
        ...actual,
        parseWslUncPath: (candidate: string) =>
          candidate.includes('codex-accounts/debian-account/home')
            ? {
                distro: 'Debian',
                linuxPath: '/home/alice/.local/share/orca/codex-accounts/debian-account/home'
              }
            : null
      }
    })
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'debian-account',
      '{"account":"debian"}\n'
    )
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'debian-account',
            email: 'debian@example.com',
            managedHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Debian',
            wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/debian/home',
            providerAccountId: null,
            workspaceLabel: null,
            workspaceAccountId: null,
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: null,
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Debian: 'debian-account' } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      expect(service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: null })).toBe(
        managedHomePath
      )
      expect(startWslCodexSessionBridgeInBackground).toHaveBeenCalledWith({
        distro: 'Debian',
        systemCodexHomePath: join(wslHome, '.codex'),
        managedCodexHomePath: managedHomePath
      })
    } finally {
      vi.doUnmock('../codex/wsl-codex-session-bridge')
      vi.doUnmock('../wsl')
      vi.doUnmock('../../shared/wsl-paths')
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('does not rescan retired sessions after the launch drain bridges them', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const startWslCodexSessionBridgeInBackground = vi.fn(() => Promise.resolve())
    vi.doMock('../codex/wsl-codex-session-bridge', () => ({
      startWslCodexSessionBridgeInBackground
    }))
    const wslHome = join(testState.userDataDir, 'ubuntu-home')
    vi.doMock('../wsl', () => ({
      getDefaultWslDistro: () => 'Ubuntu',
      getWslHome: () => wslHome
    }))
    const managedHomePath = join(wslHome, '.local', 'share', 'orca', 'codex-accounts', 'a', 'home')
    const retiredBridgeRuns = vi.fn()
    vi.doMock('./legacy-wsl-runtime-auth-drain', async (importOriginal) => ({
      ...(await importOriginal<typeof LegacyWslRuntimeAuthDrain>()),
      startLegacyWslRuntimeAuthDrain: async (options: {
        onDestinationAuthorized?: (destination: {
          authContents: string
          linuxHomePath: string
        }) => void
      }) => {
        retiredBridgeRuns()
        options.onDestinationAuthorized?.({
          authContents: '{"account":"a"}\n',
          linuxHomePath: managedHomePath
        })
      }
    }))
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'a',
            email: 'a@example.com',
            managedHomePath,
            managedHomeRuntime: 'wsl',
            wslDistro: 'Ubuntu',
            wslLinuxHomePath: managedHomePath,
            providerAccountId: 'acct-a',
            workspaceLabel: null,
            workspaceAccountId: 'acct-a',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'a' } }
      })
    )

    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      await service.prepareForCodexLaunchAsync({ runtime: 'wsl', wslDistro: 'Ubuntu' })

      expect(retiredBridgeRuns).toHaveBeenCalledTimes(1)
      expect(startWslCodexSessionBridgeInBackground).toHaveBeenCalledExactlyOnceWith({
        distro: 'Ubuntu',
        systemCodexHomePath: join(wslHome, '.codex'),
        managedCodexHomePath: managedHomePath
      })
    } finally {
      vi.doUnmock('./legacy-wsl-runtime-auth-drain')
      vi.doUnmock('../codex/wsl-codex-session-bridge')
      vi.doUnmock('../wsl')
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it.skipIf(process.platform === 'win32')(
    'links retired WSL sessions only into the auth-matched direct home',
    async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const guestHome = join(testState.userDataDir, 'ubuntu-home')
      const wslHome = `\\\\wsl.localhost\\Ubuntu${guestHome.replaceAll('/', '\\')}`
      vi.doMock('../wsl', () => ({
        getDefaultWslDistro: () => 'Ubuntu',
        getWslHome: () => wslHome
      }))
      const ownerAuth = createCodexAuthJson(
        'owner@example.com',
        'acct-owner',
        'owner-refresh',
        2_000
      )
      const selectedAuth = createCodexAuthJson(
        'selected@example.com',
        'acct-selected',
        'selected-refresh',
        2_000
      )
      const ownerHome = createManagedAuth(testState.userDataDir, 'owner', ownerAuth)
      const selectedHome = createManagedAuth(testState.userDataDir, 'selected', selectedAuth)
      vi.doMock('./wsl-codex-auth-batch-reader', async (importOriginal) => ({
        ...(await importOriginal<typeof WslCodexAuthBatchReader>()),
        readWslCodexAuths: vi.fn(async (_distro: string, homes: string[]) =>
          homes.map((home) => {
            if (home === ownerHome) {
              return { kind: 'present' as const, contents: ownerAuth }
            }
            if (home === selectedHome) {
              return { kind: 'present' as const, contents: selectedAuth }
            }
            return { kind: 'missing' as const }
          })
        )
      }))
      const drainTasks: Promise<void>[] = []
      vi.doMock('../wsl/wsl-runner', () => ({
        runWslProcess: vi.fn(
          async (options: { args?: string[]; script: string; shell?: 'bash' }) => {
            try {
              const stdout = execFileSync(options.shell === 'bash' ? '/bin/bash' : '/bin/sh', [
                '-c',
                options.script,
                options.shell ?? 'sh',
                ...(options.args ?? [])
              ]).toString()
              return {
                code: 0,
                stdout,
                stderr: '',
                timedOut: false,
                environmentResolved: true
              }
            } catch (error) {
              return {
                code: (error as { status?: number }).status ?? 1,
                stdout: (error as { stdout?: Buffer }).stdout?.toString() ?? '',
                stderr: (error as { stderr?: Buffer }).stderr?.toString() ?? '',
                timedOut: false,
                environmentResolved: true
              }
            }
          }
        )
      }))
      vi.doMock('./legacy-wsl-runtime-auth-drain', async (importOriginal) => {
        const actual = await importOriginal<typeof LegacyWslRuntimeAuthDrain>()
        return {
          ...actual,
          startLegacyWslRuntimeAuthDrain: (
            options: Parameters<typeof actual.startLegacyWslRuntimeAuthDrain>[0]
          ) => {
            const task = actual.startLegacyWslRuntimeAuthDrain(options)
            drainTasks.push(task)
            return task
          }
        }
      })
      vi.doMock('../codex/codex-home-paths', async (importOriginal) => ({
        ...(await importOriginal<typeof CodexHomePaths>()),
        syncCodexGlobalInstructionsIntoManagedHome: vi.fn()
      }))
      vi.doMock('../codex/codex-config-mirror', async (importOriginal) => ({
        ...(await importOriginal<typeof CodexConfigMirror>()),
        syncSystemConfigIntoManagedCodexHome: vi.fn()
      }))
      const retiredHome = join(guestHome, '.local', 'share', 'orca', 'codex-runtime-home', 'home')
      const relativeSessionPath = join('sessions', '2026', '08', '26', 'retired.jsonl')
      const retiredSessionPath = join(retiredHome, relativeSessionPath)
      mkdirSync(join(retiredSessionPath, '..'), { recursive: true })
      writeFileSync(join(retiredHome, 'auth.json'), ownerAuth, 'utf-8')
      writeFileSync(retiredSessionPath, '{"session":"retired"}\n', 'utf-8')
      const blockedTargetDirectory = join(ownerHome, 'sessions', '2026')
      mkdirSync(join(blockedTargetDirectory, '..'), { recursive: true })
      writeFileSync(blockedTargetDirectory, 'not-a-directory\n', 'utf-8')
      const store = createStore(
        createSettings({
          codexManagedAccounts: [
            {
              id: 'owner',
              email: 'owner@example.com',
              managedHomePath: ownerHome,
              managedHomeRuntime: 'wsl',
              wslDistro: 'Ubuntu',
              wslLinuxHomePath: ownerHome,
              providerAccountId: 'acct-owner',
              workspaceLabel: null,
              workspaceAccountId: 'acct-owner',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            },
            {
              id: 'selected',
              email: 'selected@example.com',
              managedHomePath: selectedHome,
              managedHomeRuntime: 'wsl',
              wslDistro: 'Ubuntu',
              wslLinuxHomePath: selectedHome,
              providerAccountId: 'acct-selected',
              workspaceLabel: null,
              workspaceAccountId: 'acct-selected',
              createdAt: 2,
              updatedAt: 2,
              lastAuthenticatedAt: 2
            }
          ],
          activeCodexManagedAccountIdsByRuntime: {
            host: null,
            wsl: { Ubuntu: 'selected' }
          }
        })
      )

      try {
        const { CodexRuntimeHomeService } = await import('./runtime-home-service')
        const service = new CodexRuntimeHomeService(store as never)
        service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
        await Promise.all(drainTasks)

        const linkedSessionPath = join(ownerHome, relativeSessionPath)
        expect(existsSync(linkedSessionPath)).toBe(false)
        rmSync(blockedTargetDirectory)

        service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
        await Promise.all(drainTasks)
        expect(readFileSync(linkedSessionPath, 'utf-8')).toBe('{"session":"retired"}\n')
        expect(statSync(linkedSessionPath).ino).toBe(statSync(retiredSessionPath).ino)
        expect(existsSync(join(selectedHome, relativeSessionPath))).toBe(false)

        rmSync(linkedSessionPath)
        rmSync(retiredHome, { recursive: true })
        service.prepareForCodexLaunch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
        await Promise.all(drainTasks)
        expect(existsSync(linkedSessionPath)).toBe(false)
      } finally {
        vi.doUnmock('../codex/wsl-codex-session-bridge')
        vi.doUnmock('../codex/codex-config-mirror')
        vi.doUnmock('../codex/codex-home-paths')
        vi.doUnmock('./legacy-wsl-runtime-auth-drain')
        vi.doUnmock('./wsl-codex-auth-batch-reader')
        vi.doUnmock('../wsl/wsl-runner')
        vi.doUnmock('../wsl')
        if (originalPlatform) {
          Object.defineProperty(process, 'platform', originalPlatform)
        }
      }
    }
  )
})
