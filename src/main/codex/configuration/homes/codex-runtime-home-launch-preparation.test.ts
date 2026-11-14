import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodexRuntimeHomeService } from '../../../codex-accounts/runtime-home-service'
import type * as Os from 'node:os'

const { prepareHooks, grantRead, paths } = vi.hoisted(() => ({
  prepareHooks: vi.fn(),
  grantRead: vi.fn(),
  paths: { root: '' }
}))
vi.mock('electron', () => ({ app: { getPath: () => paths.root } }))
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  homedir: () => paths.root
}))
vi.mock('../../hooks/installation/hook-service', () => ({
  codexHookService: { prepareRuntimeHomeForLaunch: prepareHooks }
}))
vi.mock('./codex-windows-sandbox-read-grant', () => ({
  grantCodexSandboxReadOnManagedHome: grantRead
}))

import { syncSystemConfigIntoManagedCodexHome } from '../settings/codex-config-mirror'
import { createCodexRuntimeHomeLaunchPreparation } from './codex-runtime-home-launch-preparation'

beforeEach(() => {
  paths.root = mkdtempSync(join(tmpdir(), 'orca-codex-launch-config-'))
  vi.clearAllMocks()
})
afterEach(() => rmSync(paths.root, { recursive: true, force: true }))

describe('managed Codex launch configuration', () => {
  it.each(['prepared', 'hooks failed'] as const)(
    'provides mirrored sandbox settings before the grant when preparation is %s',
    async (outcome) => {
      const systemHomePath = join(paths.root, '.codex')
      const runtimeHomePath = join(paths.root, 'managed')
      mkdirSync(systemHomePath)
      mkdirSync(runtimeHomePath)
      const expectedConfig = '[windows]\nsandbox = "elevated"\n'
      writeFileSync(join(systemHomePath, 'config.toml'), expectedConfig)
      const runtimeHome: Pick<CodexRuntimeHomeService, 'prepareForCodexLaunchAsync'> = {
        prepareForCodexLaunchAsync: async (_target, _env, options) => {
          const sync = (): boolean =>
            syncSystemConfigIntoManagedCodexHome({ systemHomePath, runtimeHomePath })
          if (options?.deferConfigSync) {
            options.deferConfigSync(sync)
          } else {
            sync()
          }
          return runtimeHomePath
        }
      }
      prepareHooks.mockImplementation(async (_home, _target, _enabled, _codex, config) => {
        if (outcome === 'hooks failed') {
          throw new Error('Hook preparation unavailable')
        }
        if (outcome === 'prepared') {
          config?.run()
        }
        config?.complete()
        return { state: 'installed' }
      })
      let grantedConfig: string | undefined
      grantRead.mockImplementation(async (home: string) => {
        grantedConfig = readFileSync(join(home, 'config.toml'), 'utf8')
      })
      const prepare = createCodexRuntimeHomeLaunchPreparation({
        getRuntimeHome: () => runtimeHome,
        getSettings: () => undefined
      })
      expect(await prepare()).toBe(runtimeHomePath)
      expect(grantedConfig).toContain(expectedConfig.trim())
    }
  )

  it('propagates the original deferred config failure through the hook warning boundary', async () => {
    const failure = new Error('Config could not be prepared')
    const prepare = createCodexRuntimeHomeLaunchPreparation({
      getRuntimeHome: () => ({
        prepareForCodexLaunchAsync: async (_target, _env, options) => {
          options?.deferConfigSync?.(() => {
            throw failure
          })
          return join(paths.root, 'managed')
        }
      }),
      getSettings: () => undefined
    })
    prepareHooks.mockImplementation(async (_home, _target, _enabled, _codex, config) =>
      config?.run()
    )
    await expect(prepare()).rejects.toBe(failure)
  })
})
