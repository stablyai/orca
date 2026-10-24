import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
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
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('Codex session discovery on a transcript lookup miss', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    teardownRuntimeHomeTest()
  })

  it('creates no directories and reads no account ownership markers', async () => {
    const accountHome = join(testState.userDataDir, 'codex-accounts', 'account-1', 'home')
    const store = createStore(
      createSettings({
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'user@example.com',
            managedHomePath: accountHome,
            providerAccountId: null,
            workspaceLabel: null,
            workspaceAccountId: null,
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ]
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only getSettings/updateSettings, which the harness store implements.
    const service = new CodexRuntimeHomeService(store as never)
    const { configureHostReadableTranscriptPathSources } =
      await import('../native-chat/host-readable-transcript-path')
    const { resolveSessionFilePath } = await import('../native-chat/session-file-resolver')
    configureHostReadableTranscriptPathSources({
      getAdditionalCodexHomePaths: () => service.getHostCodexHomePathsForSessionDiscovery()
    })

    rmSync(join(testState.userDataDir, 'codex-runtime-home'), { recursive: true, force: true })
    rmSync(join(testState.userDataDir, 'codex-accounts'), { recursive: true, force: true })
    const before = readdirSync(testState.userDataDir).sort()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(resolveSessionFilePath('codex', 'never-written-session')).resolves.toBeNull()
      await expect(resolveSessionFilePath('codex', 'never-written-session')).resolves.toBeNull()

      expect(existsSync(getRuntimeCodexHomePath())).toBe(false)
      expect(readdirSync(testState.userDataDir).sort()).toEqual(before)

      expect(warn).not.toHaveBeenCalled()
      expect(service.getHostCodexHomePathsForSessionDiscovery()).toContain(
        getRuntimeCodexHomePath()
      )
    } finally {
      warn.mockRestore()
      configureHostReadableTranscriptPathSources({})
    }
  })
})
