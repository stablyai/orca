import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from '../runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createStore,
  getRuntimeCodexAuthPath,
  getRuntimeCodexHomePath,
  getSystemCodexAuthPath,
  getSystemCodexHomePath,
  setRealHomeRoutableForTest,
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
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

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

  it('seeds shared auth for a pane-local custom home on the real-home lane', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system-token')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ realHomeRoutable: true }))
    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    const customHome = join(testState.fakeHomeDir, 'pane-custom-codex-home')

    expect(service.prepareForCodexLaunch(undefined, { CODEX_HOME: customHome })).toBe(
      getRuntimeCodexHomePath()
    )
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(systemAuth)
  })

  it('keeps pre-rollout shared-home panes authenticated on the real-home lane', async () => {
    const oldSystemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-system')
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const systemConfig = [
      'model_provider = "codex-lb"',
      '',
      '[model_providers.codex-lb]',
      'base_url = "https://codex-lb.example.test/v1"',
      'requires_openai_auth = true',
      ''
    ].join('\n')
    writeFileSync(getSystemCodexAuthPath(), oldSystemAuth, 'utf-8')
    const store = createStore(createSettings({ realHomeRoutable: false }))
    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    new CodexRuntimeHomeService(store as never)
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(oldSystemAuth)

    setRealHomeRoutableForTest(true)
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    writeFileSync(join(getSystemCodexHomePath(), 'config.toml'), systemConfig, 'utf-8')
    writeFileSync(
      join(getRuntimeCodexHomePath(), 'config.toml'),
      'model_provider = "stale-provider"\n',
      'utf-8'
    )

    const service = new CodexRuntimeHomeService(store as never)

    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(oldSystemAuth)
    expect(readFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), 'utf-8')).toContain(
      'stale-provider'
    )
    service.reconcileLegacySharedHomeForRetainedPanes()
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(readFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), 'utf-8')).toBe(systemConfig)
    expect(service.prepareForCodexLaunch()).toBeNull()
  })

  it('preserves retained managed auth across a real-home main-process restart', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const managedAuth = createCodexAuthJson('managed@example.com', 'acct-managed', 'managed')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ realHomeRoutable: false }))
    const { CodexRuntimeHomeService } = await import('../../runtime-home-service')
    new CodexRuntimeHomeService(store as never)
    writeFileSync(getRuntimeCodexAuthPath(), managedAuth, 'utf-8')

    setRealHomeRoutableForTest(true)
    const restartedService = new CodexRuntimeHomeService(store as never)

    expect(restartedService.prepareForCodexLaunch()).toBeNull()
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(managedAuth)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
  })
})
