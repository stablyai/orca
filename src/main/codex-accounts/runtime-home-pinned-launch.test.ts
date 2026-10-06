import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type * as NodeOs from 'node:os'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAccountRecord,
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  getRuntimeCodexAuthPath,
  getSystemCodexAuthPath,
  getSystemCodexHomePath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => testState.fakeHomeDir
}))

describe('Codex launch pins do not transition the active account', () => {
  beforeEach(() => setupRuntimeHomeTest())
  afterEach(() => teardownRuntimeHomeTest())

  async function fixture() {
    const authA = createCodexAuthJson('a@example.com', 'provider-a', 'fixture-refresh-a')
    const authB = createCodexAuthJson('b@example.com', 'provider-b', 'fixture-refresh-b')
    const homeA = createManagedAuth(testState.userDataDir, 'account-a', authA)
    const homeB = createManagedAuth(testState.userDataDir, 'account-b', authB)
    writeFileSync(getSystemCodexAuthPath(), '{"fixture":"system"}\n')
    const settings = createSettings({
      realHomeRoutable: true,
      codexManagedAccounts: [
        createCodexAccountRecord('account-a', 'a@example.com', 'provider-a', homeA),
        createCodexAccountRecord('account-b', 'b@example.com', 'provider-b', homeB)
      ],
      activeCodexManagedAccountId: 'account-a',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-a', wsl: {} }
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this home-service fixture exercises only settings access; any omitted store member fails on use.
    const service = new CodexRuntimeHomeService(store as never)
    return { service, store, settings, homeA, homeB, authA, authB }
  }

  it('prepares simultaneous A and B launches without touching either credential or global routing', async () => {
    const { service, store, settings, homeA, homeB, authA, authB } = await fixture()
    const selection = structuredClone(settings)
    store.updateSettings.mockClear()
    const launches = await Promise.all(
      ['account-a', 'B@EXAMPLE.COM'].map(async (selector) => {
        const receipt = service.resolveLaunchAccount(selector)
        return { receipt, home: service.prepareForPinnedCodexLaunch(receipt.effective.id) }
      })
    )
    expect(launches.map((launch) => launch.home)).toEqual([homeA, homeB])
    expect(launches.map((launch) => launch.receipt.effective.id)).toEqual([
      'account-a',
      'account-b'
    ])
    expect(settings).toEqual(selection)
    expect(store.updateSettings).not.toHaveBeenCalled()
    expect(service.resolveHostCodexHomePathForLaunchReadOnly()).toBe(homeA)
    expect(readFileSync(join(homeA, 'auth.json'), 'utf8')).toBe(authA)
    expect(readFileSync(join(homeB, 'auth.json'), 'utf8')).toBe(authB)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf8')).toBe('{"fixture":"system"}\n')
    expect(existsSync(getRuntimeCodexAuthPath())).toBe(false)
  })

  it('pins system to the canonical home despite managed selection and inherited CODEX_HOME', async () => {
    const { service, store, homeA } = await fixture()
    vi.stubEnv('CODEX_HOME', homeA)
    vi.stubEnv('ORCA_CODEX_HOME', homeA)
    try {
      expect(
        service.prepareForPinnedCodexLaunch(
          service.resolveLaunchAccount('System default').effective.id
        )
      ).toBe(getSystemCodexHomePath())
      expect(service.resolveHostCodexHomePathForLaunchReadOnly()).toBe(homeA)
      expect(store.updateSettings).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('refuses an untrusted requested home without clearing the globally active account', async () => {
    const { service, store, settings, homeB, homeA } = await fixture()
    writeFileSync(join(homeB, '.orca-managed-home'), 'wrong-owner\n')
    expect(() => service.resolveLaunchAccount('account-b')).toThrow('untrusted')
    expect(settings.activeCodexManagedAccountId).toBe('account-a')
    expect(store.updateSettings).not.toHaveBeenCalled()
    expect(service.resolveHostCodexHomePathForLaunchReadOnly()).toBe(homeA)
  })
})
