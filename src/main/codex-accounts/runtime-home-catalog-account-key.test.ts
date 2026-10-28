import type * as NodeOs from 'node:os'
import type * as NodeFs from 'node:fs'
import {
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { resolveCodexLaunchHome } from '../codex/codex-launch-home'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAccountRecord,
  createCodexAuthJson,
  createManagedAuth,
  createStore,
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
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) }
})

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

// Hook install and session bridges are launch chores outside the key; keep them off disk.
vi.mock('../codex/hook-service', () => ({
  codexHookService: { prepareRuntimeHomeForLaunch: async () => ({ state: 'installed' }) }
}))
vi.mock('../codex/codex-hook-reconcile', () => ({ reconcileCodexHooksForLaunch: async () => {} }))
vi.mock('../codex/codex-session-bridge', () => ({
  startSystemCodexSessionBridgeInBackground: async () => {}
}))
vi.mock('../codex/codex-account-session-bridge', () => ({
  startCodexAccountSessionBridgeInBackground: async () => {}
}))

// Use production wiring so catalog reads and launches cannot silently drift apart.
async function wireCodexAccountKey(
  settings: ReturnType<typeof createSettings>,
  launchEnv: NodeJS.ProcessEnv = {}
) {
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  const { mainProcessState } = await import('../startup/main-process-state')
  const { codexStructuredLaunchHomeResolvers } = await import('../startup/codex-launch-preparation')
  const { structuredAgentRuntimeRegistration } =
    await import('../runtime/structured-agent-runtime-registrations')
  const { agentModelCatalogFingerprint } =
    await import('../native-chat/agent-model-catalog/agent-model-catalog-fingerprint')
  const store = createStore(settings)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness store implements the settings surface consumed by the service.
  const runtimeHome = new CodexRuntimeHomeService(store as never)
  mainProcessState.codexRuntimeHome = runtimeHome
  const codex = structuredAgentRuntimeRegistration('codex')!
  const services = {
    getClaudeConfigDirectory: () => null,
    prepareCodexLaunchHome: codexStructuredLaunchHomeResolvers.prepareCodexStructuredLaunch,
    readCodexLaunchHome: codexStructuredLaunchHomeResolvers.resolveCodexStructuredLaunchHome,
    workspaceTrustSettings: () => settings,
    stateDirectory: '/orca-data'
  }
  const resolve = (purpose: 'launch' | 'read', conversationHome?: string) =>
    codex.resolveAccountHome(
      { launchEnv, location: null, purpose, workspacePath: null, conversationHome },
      services
    )
  const key = (accountHome: AgentSessionAccountHome) =>
    agentModelCatalogFingerprint({ agent: 'codex', accountHome, wslDistro: null })
  return {
    resolve,
    key,
    runtimeHome,
    store,
    release: () => (mainProcessState.codexRuntimeHome = null)
  }
}

describe('Codex catalog account key: picker read vs launch', () => {
  let release: (() => void) | null = null

  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    vi.useRealTimers()
    release?.()
    release = null
    teardownRuntimeHomeTest()
  })

  it('probes the healthy store with an unrelated offline retained alias and observes its restoration', async () => {
    const login = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('user@example.com', 'acct-1', 'refresh-1')
    )
    const healthy = join(testState.fakeHomeDir, 'healthy-store')
    const removable = join(testState.fakeHomeDir, 'removable-store')
    mkdirSync(healthy)
    mkdirSync(removable)
    const retained = resolveCodexLaunchHome({
      selectedAccount: { homePath: login },
      storeHome: removable
    })!
    const link = readlinkSync(join(retained, 'sessions'))
    const offline = join(testState.fakeHomeDir, 'unmounted-store')
    renameSync(removable, offline)
    const settings = createSettings({
      realHomeRoutable: true,
      codexSessionSourceHome: { host: healthy },
      codexManagedAccounts: [
        createCodexAccountRecord('account-1', 'user@example.com', 'acct-1', login)
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const wired = await wireCodexAccountKey(settings)
    release = wired.release
    const inventoryCount = () =>
      vi
        .mocked(readdirSync)
        .mock.calls.filter(
          ([path]) => String(path) === join(testState.userDataDir, 'codex-accounts')
        ).length
    const { createCodexModelCatalogProbe } = await import('../codex/codex-model-catalog-probe')
    const { resolveStructuredCodexAccountKind } =
      await import('../runtime/structured-agent-account-home')
    let expectedStore = healthy
    const prepared: string[] = []
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({}),
      resolveCommand: () => 'codex',
      resolveAccountKind: (home) =>
        resolveStructuredCodexAccountKind(home, wired.store.getSettings()),
      prepareHome: (home) => {
        wired.runtimeHome.prepareHostCodexHomeForReadOnlyAppServer(home)
        prepared.push(home)
      },
      runSession: async (invocation, body) => {
        expect(invocation.env?.CODEX_HOME).toBe(prepared.at(-1))
        expect(realpathSync(join(invocation.env!.CODEX_HOME!, 'sessions'))).toBe(
          realpathSync(join(expectedStore, 'sessions'))
        )
        return body({
          request: async (method) =>
            method === 'account/read'
              ? {
                  requiresOpenaiAuth: true,
                  account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' }
                }
              : method === 'config/read'
                ? { config: {} }
                : {
                    data: [
                      {
                        model: 'gpt-live',
                        displayName: 'GPT Live',
                        hidden: false,
                        supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
                        isDefault: true
                      }
                    ],
                    nextCursor: null
                  },
          notify: () => {}
        })
      }
    })
    for (const restored of [false, true]) {
      if (restored) {
        renameSync(offline, removable)
      }
      const read = await wired.resolve('read')
      expect(wired.runtimeHome.getHostCodexHomePathsForSessionDiscovery()).toEqual(
        expect.arrayContaining([
          retained,
          join(realpathSync(testState.fakeHomeDir), 'removable-store')
        ])
      )
      vi.mocked(readdirSync).mockClear()
      expect(await probe(read)).toMatchObject({ models: [{ id: 'gpt-live' }], origin: 'probe' })
      expect(inventoryCount()).toBe(1)
      expect(wired.key(await wired.resolve('launch'))).toBe(wired.key(read))
      expect(readlinkSync(join(retained, 'sessions'))).toBe(link)
    }
    expectedStore = removable
    expect(await wired.resolve('read', retained)).toMatchObject({ path: retained })
    vi.mocked(readdirSync).mockClear()
    expect(await probe(await wired.resolve('read', retained))).toMatchObject({
      models: [{ id: 'gpt-live' }]
    })
    expect(inventoryCount()).toBe(1)
    expect(prepared).toHaveLength(3)
    expect(wired.store.getSettings().activeCodexManagedAccountId).toBe('account-1')
  })

  it('settles transient managed-overlay readiness through the real service and retains managed catalog recovery', async () => {
    const auth = createCodexAuthJson('user@example.com', 'acct-1', 'refresh-1')
    const login = createManagedAuth(testState.userDataDir, 'account-1', auth)
    const settings = createSettings({
      realHomeRoutable: true,
      codexManagedAccounts: [
        createCodexAccountRecord('account-1', 'user@example.com', 'acct-1', login)
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const wired = await wireCodexAccountKey(settings)
    release = wired.release
    const recorded = await wired.resolve('launch')
    const overlay = requireLegacyAgentSessionAccountHome(recorded).path
    const { resolveCodexHomeAfterManagedAuthReadiness } =
      await import('../ipc/pty/host-env/codex-home')
    writeFileSync(
      join(login, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'access-acct-1' } })
    )
    vi.useFakeTimers()
    const resolveCurrent = vi.fn(() =>
      wired.runtimeHome.prepareForCodexLaunchAsync(undefined, {}, { conversationHome: overlay })
    )
    const resolveAfterUnavailable = vi.fn((home: string) =>
      wired.runtimeHome.prepareForCodexLaunchAsync(
        undefined,
        {},
        { conversationHome: overlay, unavailableManagedHomePath: home }
      )
    )
    const pending = resolveCodexHomeAfterManagedAuthReadiness({
      selectedCodexHomePath: overlay,
      getSettings: () => wired.store.getSettings(),
      target: { runtime: 'host' },
      resolveCurrent,
      resolveAfterUnavailable
    })
    expect(pending).toBeInstanceOf(Promise)
    await vi.advanceTimersByTimeAsync(50)
    writeFileSync(join(login, 'auth.json'), auth)
    await vi.advanceTimersByTimeAsync(25)
    await expect(pending).resolves.toBe(overlay)
    expect(resolveCurrent).toHaveBeenCalledOnce()
    expect(resolveAfterUnavailable).not.toHaveBeenCalled()
    vi.useRealTimers()
    expect(wired.store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    expect(await wired.resolve('read', overlay)).toEqual(recorded)

    const { createCodexModelCatalogProbe } = await import('../codex/codex-model-catalog-probe')
    const { resolveStructuredCodexAccountKind } =
      await import('../runtime/structured-agent-account-home')
    const { AgentModelCatalogUnavailableError } =
      await import('../native-chat/agent-model-catalog/agent-model-catalog-unavailable')
    const { agentSessionSignInCopyId } = await import('../../shared/agent-session-availability')
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({}),
      resolveCommand: () => 'codex',
      prepareHome: (home) => wired.runtimeHome.prepareHostCodexHomeForReadOnlyAppServer(home),
      resolveAccountKind: (home) =>
        resolveStructuredCodexAccountKind(home, wired.store.getSettings()),
      runSession: async (invocation, body) => {
        expect(invocation.env?.CODEX_HOME).toBe(overlay)
        return body({
          request: async (method) =>
            method === 'account/read'
              ? { requiresOpenaiAuth: true, account: null }
              : method === 'config/read'
                ? { config: {} }
                : { data: [], nextCursor: null },
          notify: () => {}
        })
      }
    })
    unlinkSync(join(login, 'auth.json'))
    const failure: unknown = await probe(recorded).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AgentModelCatalogUnavailableError)
    if (!(failure instanceof AgentModelCatalogUnavailableError)) {
      throw new Error('Expected unavailable catalog')
    }
    expect(failure.unavailable).toEqual({ reason: 'notSignedIn', account: 'managed' })
    expect(
      agentSessionSignInCopyId(
        'codex',
        failure.unavailable.reason === 'notSignedIn' ? failure.unavailable.account : undefined
      )
    ).toBe('codexManagedNotSignedIn')
    expect(wired.store.getSettings().activeCodexManagedAccountId).toBe('account-1')
  })

  async function expectOneKey(settings: ReturnType<typeof createSettings>, expectedPath: string) {
    const wired = await wireCodexAccountKey(settings)
    release = wired.release
    const before = await wired.resolve('read')
    const launched = await wired.resolve('launch')
    const after = await wired.resolve('read')

    expect(launched).toMatchObject({ variable: 'CODEX_HOME', path: expectedPath })
    expect(wired.key(before)).toBe(wired.key(launched))
    expect(wired.key(after)).toBe(wired.key(launched))
  }

  it('system account on the real ~/.codex', async () => {
    await expectOneKey(createSettings({ realHomeRoutable: true }), getSystemCodexHomePath())
  })

  it('system account no longer routes through the legacy mirror', async () => {
    await expectOneKey(createSettings({ realHomeRoutable: false }), getSystemCodexHomePath())
  })

  it('pins read and actual launch inputs to system selection despite a custom CODEX_HOME', async () => {
    const custom = '/fixture/custom-codex-home'
    const wired = await wireCodexAccountKey(createSettings({ realHomeRoutable: true }), {
      CODEX_HOME: custom
    })
    release = wired.release
    const read = await wired.resolve('read')
    const launched = await wired.resolve('launch')
    expect(requireLegacyAgentSessionAccountHome(read).path).toBe(getSystemCodexHomePath())
    expect(launched).toEqual(read)
    const { createCodexModelCatalogProbe } = await import('../codex/codex-model-catalog-probe')
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({ CODEX_HOME: custom }),
      resolveCommand: () => 'codex',
      runSession: async (invocation, body) => {
        expect(invocation.env?.CODEX_HOME).toBe(requireLegacyAgentSessionAccountHome(launched).path)
        return body({
          request: async () => ({
            data: [
              {
                model: 'gpt-live',
                displayName: 'GPT Live',
                hidden: false,
                supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
                isDefault: true
              }
            ],
            nextCursor: null
          }),
          notify: () => {}
        })
      }
    })
    expect((await probe(read)).models.map((model) => model.id)).toEqual(['gpt-live'])
  })

  it('a managed account overlay over the shared conversation store', async () => {
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('user@example.com', 'acct-1', 'refresh-1')
    )
    await expectOneKey(
      createSettings({
        realHomeRoutable: true,
        codexManagedAccounts: [
          createCodexAccountRecord('account-1', 'user@example.com', 'acct-1', managedHomePath)
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      }),
      resolveCodexLaunchHome({ selectedAccount: { homePath: managedHomePath }, readOnly: true })!
    )
  })
})
