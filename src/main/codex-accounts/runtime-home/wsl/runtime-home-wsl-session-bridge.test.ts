import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as CodexConfigMirror from '../../../codex/configuration/settings/codex-config-mirror'
import type * as CodexHomePaths from '../../../codex/configuration/homes/codex-home-paths'
import type * as LegacyWslRuntimeAuthDrain from '../../legacy-wsl-auth-drain/legacy-wsl-runtime-auth-drain'
import type * as WslCodexAuthBatchReader from './wsl-codex-auth-batch-reader'
import type * as WslCodexSessionBridge from '../../../codex/history/bridges/wsl-codex-session-bridge'
import { createSettings } from '../runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from '../runtime-home-service-test-harness'

// These launches are the user's own, so the E9 exec gate lets their prep run.
vi.mock('../../../wsl/discovery/wsl-background-exec-gate', () => ({
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

  it.skipIf(process.platform === 'win32')(
    'links retired WSL sessions only into the auth-matched direct home',
    async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const guestHome = join(testState.userDataDir, 'ubuntu-home')
      const wslHome = `\\\\wsl.localhost\\Ubuntu${guestHome.replaceAll('/', '\\')}`
      vi.doMock('../../../wsl/discovery/distro-catalog', () => ({
        getDefaultWslDistro: () => 'Ubuntu',
        getWslHome: () => wslHome,
        getWslHomeAsync: async () => wslHome
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
      vi.doMock('../../../wsl/execution/wsl-runner', () => ({
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
      vi.doMock(
        '../../legacy-wsl-auth-drain/legacy-wsl-runtime-auth-drain',
        async (importOriginal) => {
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
        }
      )
      vi.doMock('../../../codex/configuration/homes/codex-home-paths', async (importOriginal) => ({
        ...(await importOriginal<typeof CodexHomePaths>()),
        syncCodexGlobalInstructionsIntoManagedHome: vi.fn()
      }))
      vi.doMock(
        '../../../codex/configuration/settings/codex-config-mirror',
        async (importOriginal) => ({
          ...(await importOriginal<typeof CodexConfigMirror>()),
          syncSystemConfigIntoManagedCodexHome: vi.fn()
        })
      )
      // Launch-time sibling bridging is covered elsewhere; this pins only the drain's own target.
      vi.doMock(
        '../../../codex/history/bridges/wsl-codex-session-bridge',
        async (importOriginal) => ({
          ...(await importOriginal<typeof WslCodexSessionBridge>()),
          startWslCodexSessionBridgeInBackground: vi.fn(() => Promise.resolve())
        })
      )
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
        const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
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
        vi.doUnmock('../../../codex/history/bridges/wsl-codex-session-bridge')
        vi.doUnmock('../../../codex/configuration/settings/codex-config-mirror')
        vi.doUnmock('../../../codex/configuration/homes/codex-home-paths')
        vi.doUnmock('../../legacy-wsl-auth-drain/legacy-wsl-runtime-auth-drain')
        vi.doUnmock('./wsl-codex-auth-batch-reader')
        vi.doUnmock('../../../wsl/execution/wsl-runner')
        vi.doUnmock('../../../wsl/discovery/distro-catalog')
        if (originalPlatform) {
          Object.defineProperty(process, 'platform', originalPlatform)
        }
      }
    }
  )
})
