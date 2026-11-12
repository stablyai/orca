import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { createSettings } from '../runtime-home-settings-test-fixtures'
import {
  createStore,
  expectResourceLinkedOrCopied,
  getRuntimeCodexHomePath,
  getSystemCodexHomePath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from '../runtime-home-service-test-harness'

// Keep asserted config bytes independent of platform socket-path limits.
vi.mock(
  '../../../codex/configuration/shared-server/codex-daemon-socket-path-guard',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    applyCodexDaemonSocketGuard: (config: string) => config
  })
)

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

  it('rebases the bundled marketplace onto the canonical path of a symlinked managed home', async () => {
    const systemMarketplace = join(
      getSystemCodexHomePath(),
      '.tmp',
      'bundled-marketplaces',
      'openai-bundled'
    )
    mkdirSync(systemMarketplace, { recursive: true })
    writeFileSync(
      join(getSystemCodexHomePath(), 'config.toml'),
      `[marketplaces.openai-bundled]\nsource_type = "local"\nsource = '${systemMarketplace}'\n`,
      'utf-8'
    )
    const linkedUserData = join(testState.fakeHomeDir, 'linked-user-data')
    symlinkSync(testState.userDataDir, linkedUserData, 'junction')
    process.env.ORCA_USER_DATA_PATH = linkedUserData
    const store = createStore(createSettings())
    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    service.prepareForCodexLaunch()

    // Codex compares against its canonicalized CODEX_HOME, so the source must not keep the link.
    const canonicalMarketplace = join(
      realpathSync.native(testState.userDataDir),
      'codex-runtime-home',
      'home',
      '.tmp',
      'bundled-marketplaces',
      'openai-bundled'
    )
    expect(readFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), 'utf-8')).toContain(
      `source = '${canonicalMarketplace}'`
    )
    expect(existsSync(canonicalMarketplace)).toBe(true)
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
    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
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
