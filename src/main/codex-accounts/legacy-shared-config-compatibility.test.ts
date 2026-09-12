import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncLegacySharedCodexConfigForRetainedPanes } from './legacy-shared-config-compatibility'
import type * as FsUtils from './fs-utils'

const generationRace = vi.hoisted(() => ({
  path: null as string | null,
  beforeGuardedReplace: null as (() => void) | null
}))

vi.mock('./fs-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof FsUtils>()
  return {
    ...actual,
    writeFileAtomicallyIfUnchanged: (
      path: string,
      expectedContents: string | null,
      contents: string,
      options?: { mode?: number }
    ) => {
      if (path === generationRace.path) {
        generationRace.beforeGuardedReplace?.()
      }
      return actual.writeFileAtomicallyIfUnchanged(path, expectedContents, contents, options)
    }
  }
})

let root: string
let sharedRuntimeHome: string
let systemCodexHome: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-legacy-codex-home-'))
  sharedRuntimeHome = join(root, 'codex-runtime-home', 'home')
  systemCodexHome = join(root, 'system-home', '.codex')
  mkdirSync(sharedRuntimeHome, { recursive: true })
  mkdirSync(systemCodexHome, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  generationRace.path = null
  generationRace.beforeGuardedReplace = null
  vi.restoreAllMocks()
})

describe('legacy shared Codex config compatibility', () => {
  it('refreshes retained panes with the authenticated production provider config', () => {
    const staleSharedAuth = '{"tokens":{"access_token":"stale"}}\n'
    const systemConfig = [
      'model_provider = "codex-lb"',
      '',
      '[model_providers.codex-lb]',
      'base_url = "https://codex-lb.example.test/v1"',
      'requires_openai_auth = true',
      ''
    ].join('\n')
    writeFileSync(join(systemCodexHome, 'config.toml'), systemConfig, 'utf-8')
    writeFileSync(join(sharedRuntimeHome, 'auth.json'), staleSharedAuth)
    writeFileSync(
      join(sharedRuntimeHome, 'config.toml'),
      [
        'model_provider = "stale-provider"',
        '',
        '[hooks.state."orca:stop:0:0"]',
        'enabled = true',
        ''
      ].join('\n')
    )

    syncLegacySharedCodexConfigForRetainedPanes({ sharedRuntimeHome, systemCodexHome })

    const sharedConfig = readFileSync(join(sharedRuntimeHome, 'config.toml'), 'utf-8')
    expect(sharedConfig).toContain('model_provider = "codex-lb"')
    expect(sharedConfig).toContain('requires_openai_auth = true')
    expect(sharedConfig).not.toContain('stale-provider')
    expect(sharedConfig).toContain('[hooks.state."orca:stop:0:0"]')
    expect(readFileSync(join(systemCodexHome, 'config.toml'), 'utf-8')).toBe(systemConfig)
    expect(readFileSync(join(sharedRuntimeHome, 'auth.json'), 'utf-8')).toBe(staleSharedAuth)
  })

  it('does not delete config when the canonical source is transiently missing', () => {
    const staleConfig = 'model_provider = "stale-provider"\n'
    writeFileSync(join(sharedRuntimeHome, 'config.toml'), staleConfig, 'utf-8')

    syncLegacySharedCodexConfigForRetainedPanes({ sharedRuntimeHome, systemCodexHome })

    expect(readFileSync(join(sharedRuntimeHome, 'config.toml'), 'utf-8')).toBe(staleConfig)
  })

  it('does not promote retained-pane settings into the real home', () => {
    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "canonical"\n', 'utf-8')
    writeFileSync(join(sharedRuntimeHome, 'config.toml'), 'model = "retained-pane-change"\n')

    syncLegacySharedCodexConfigForRetainedPanes({ sharedRuntimeHome, systemCodexHome })

    expect(readFileSync(join(systemCodexHome, 'config.toml'), 'utf-8')).toBe(
      'model = "canonical"\n'
    )
    expect(readFileSync(join(sharedRuntimeHome, 'config.toml'), 'utf-8')).toBe(
      'model = "canonical"\n'
    )
  })

  it('does not overwrite trust appended by a retained Codex during the mirror', () => {
    const runtimeConfigPath = join(sharedRuntimeHome, 'config.toml')
    const runtimeConfig = 'model = "runtime-before"\n'
    const concurrentConfig = [
      runtimeConfig.trimEnd(),
      '',
      '[projects."/newly-trusted"]',
      'trust_level = "trusted"',
      ''
    ].join('\n')
    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "canonical"\n', 'utf-8')
    writeFileSync(runtimeConfigPath, runtimeConfig, 'utf-8')
    generationRace.path = runtimeConfigPath
    generationRace.beforeGuardedReplace = () => {
      writeFileSync(runtimeConfigPath, concurrentConfig, 'utf-8')
    }

    syncLegacySharedCodexConfigForRetainedPanes({ sharedRuntimeHome, systemCodexHome })

    expect(readFileSync(runtimeConfigPath, 'utf-8')).toBe(concurrentConfig)
  })

  it('does not block real-home launch when compatibility config refresh fails', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "canonical"\n', 'utf-8')
    mkdirSync(join(sharedRuntimeHome, 'config.toml'))

    expect(() =>
      syncLegacySharedCodexConfigForRetainedPanes({ sharedRuntimeHome, systemCodexHome })
    ).not.toThrow()

    expect(warnSpy).toHaveBeenCalledWith(
      '[codex-runtime-home] Failed to refresh legacy shared config:',
      expect.anything()
    )
  })
})
