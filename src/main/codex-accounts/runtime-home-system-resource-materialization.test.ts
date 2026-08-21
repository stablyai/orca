import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createStore,
  expectResourceLinkedOrCopied,
  getRuntimeCodexAuthPath,
  getRuntimeCodexHomePath,
  getSystemCodexHomePath,
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

  it('mirrors later system Codex config changes before launch', async () => {
    const systemCodexHome = getSystemCodexHomePath()
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "first"\n', 'utf-8')
    const store = createStore(createSettings())
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    service.prepareForCodexLaunch()
    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "second"\n', 'utf-8')
    service.prepareForCodexLaunch()

    expect(readFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), 'utf-8')).toBe(
      'model = "second"\n'
    )
  })

  it('launches the system-default custom provider without requiring OAuth auth', async () => {
    const systemCodexHome = getSystemCodexHomePath()
    const canonicalConfigPath = join(systemCodexHome, 'config.toml')
    const canonicalConfig = [
      'model_provider = "codex-lb"',
      '',
      '[model_providers.codex-lb]',
      'base_url = "https://codex-lb.example.test/v1"',
      'env_key = "CODEX_LB_API_KEY"',
      ''
    ].join('\n')
    writeFileSync(canonicalConfigPath, canonicalConfig, 'utf-8')
    const store = createStore(createSettings({ shellStartupEnvProbeSupported: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareForCodexLaunch()).toBe(getRuntimeCodexHomePath())
    expect(readFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), 'utf-8')).toBe(
      canonicalConfig
    )
    expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)
    expect(readFileSync(canonicalConfigPath, 'utf-8')).toBe(canonicalConfig)
  })

  it('links system Codex user resources into the managed runtime home before launch', async () => {
    const systemCodexHome = getSystemCodexHomePath()
    mkdirSync(join(systemCodexHome, 'skills', 'review'), { recursive: true })
    writeFileSync(join(systemCodexHome, 'skills', 'review', 'SKILL.md'), 'review skill\n', 'utf-8')
    mkdirSync(join(systemCodexHome, 'plugins'), { recursive: true })
    writeFileSync(join(systemCodexHome, 'plugins', 'plugin.json'), '{"name":"plugin"}\n', 'utf-8')
    writeFileSync(join(systemCodexHome, 'profile-v2'), 'profile\n', 'utf-8')
    const store = createStore(createSettings())
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    service.prepareForCodexLaunch()

    const runtimeSkillsPath = join(getRuntimeCodexHomePath(), 'skills')
    const runtimePluginsPath = join(getRuntimeCodexHomePath(), 'plugins')
    const runtimeProfilePath = join(getRuntimeCodexHomePath(), 'profile-v2')
    expectResourceLinkedOrCopied(runtimeSkillsPath, join(systemCodexHome, 'skills'))
    expectResourceLinkedOrCopied(runtimePluginsPath, join(systemCodexHome, 'plugins'))
    expectResourceLinkedOrCopied(runtimeProfilePath, join(systemCodexHome, 'profile-v2'))
    expect(readFileSync(join(runtimeSkillsPath, 'review', 'SKILL.md'), 'utf-8')).toBe(
      'review skill\n'
    )
    expect(readFileSync(runtimeProfilePath, 'utf-8')).toBe('profile\n')
  })

  it('starts the system Codex session bridge without replacing runtime sessions', async () => {
    const systemMissingRuntimeSessionPath = join(
      getSystemCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-old.jsonl'
    )
    const systemConflictSessionPath = join(
      getSystemCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-conflict.jsonl'
    )
    const runtimeConflictSessionPath = join(
      getRuntimeCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-conflict.jsonl'
    )
    mkdirSync(join(getSystemCodexHomePath(), 'sessions', '2026', '05', '26'), { recursive: true })
    mkdirSync(join(getRuntimeCodexHomePath(), 'sessions', '2026', '05', '26'), {
      recursive: true
    })
    writeFileSync(systemMissingRuntimeSessionPath, '{"id":"old"}\n', 'utf-8')
    writeFileSync(systemConflictSessionPath, '{"id":"system-conflict"}\n', 'utf-8')
    writeFileSync(runtimeConflictSessionPath, '{"id":"runtime-conflict"}\n', 'utf-8')
    writeFileSync(join(getSystemCodexHomePath(), 'state_5.sqlite'), 'sqlite\n', 'utf-8')
    const store = createStore(createSettings())
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const { startSystemCodexSessionBridgeInBackground } =
      await import('../codex/codex-session-bridge')
    const service = new CodexRuntimeHomeService(store as never)

    service.prepareForCodexLaunch()
    await startSystemCodexSessionBridgeInBackground()

    const runtimeMissingSessionPath = join(
      getRuntimeCodexHomePath(),
      'sessions',
      '2026',
      '05',
      '26',
      'rollout-old.jsonl'
    )
    expect(readFileSync(runtimeMissingSessionPath, 'utf-8')).toBe('{"id":"old"}\n')
    expectResourceLinkedOrCopied(runtimeMissingSessionPath, systemMissingRuntimeSessionPath)
    expect(readFileSync(runtimeConflictSessionPath, 'utf-8')).toBe('{"id":"runtime-conflict"}\n')
    expect(existsSync(join(getRuntimeCodexHomePath(), 'state_5.sqlite'))).toBe(false)
  })

  it('does not replace runtime-owned Codex files while linking user resources', async () => {
    const systemCodexHome = getSystemCodexHomePath()
    mkdirSync(join(systemCodexHome, 'sessions'), { recursive: true })
    mkdirSync(join(systemCodexHome, 'skills'), { recursive: true })
    writeFileSync(join(systemCodexHome, 'auth.json'), '{"account":"system"}\n', 'utf-8')
    writeFileSync(join(systemCodexHome, 'hooks.json'), '{"hooks":{}}\n', 'utf-8')
    writeFileSync(join(systemCodexHome, 'skills', 'system.md'), 'system\n', 'utf-8')
    writeFileSync(join(getRuntimeCodexHomePath(), 'hooks.json'), '{"hooks":{"Stop":[]}}\n', 'utf-8')
    writeFileSync(join(getRuntimeCodexHomePath(), 'history.jsonl'), '{"id":"runtime"}\n', 'utf-8')
    const store = createStore(createSettings())
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    service.prepareForCodexLaunch()

    expect(readFileSync(join(getRuntimeCodexHomePath(), 'auth.json'), 'utf-8')).toBe(
      '{"account":"system"}\n'
    )
    expect(readFileSync(join(getRuntimeCodexHomePath(), 'hooks.json'), 'utf-8')).toBe(
      '{"hooks":{"Stop":[]}}\n'
    )
    expect(readFileSync(join(getRuntimeCodexHomePath(), 'history.jsonl'), 'utf-8')).toBe(
      '{"id":"runtime"}\n'
    )
    expect(existsSync(join(getRuntimeCodexHomePath(), 'sessions'))).toBe(false)
    expectResourceLinkedOrCopied(
      join(getRuntimeCodexHomePath(), 'skills'),
      join(systemCodexHome, 'skills')
    )
  })
})
