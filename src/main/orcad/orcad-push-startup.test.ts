import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProfilePreferences } from '../persistence/loading-store/profile-preferences/profile-preferences'
import type { RuntimeConstructionDependencies } from '../runtime/construction/runtime-construction-dependencies'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { DeviceRegistry } from '../runtime/rpc/server/pairing/device-registry'
import { RuntimeMobileNotificationController } from '../runtime/push/notifications/runtime-mobile-notification-controller'
import { PushUnregisterOutbox } from '../runtime/push/push-unregister-outbox'
import { createPushHostKeypair } from '../runtime/push/push-host-challenge-fixtures'
import { acquireProfileStateMaintenance } from '../persistence/profile-state/access/profile-state-access'
import { profileStateAccessPaths } from '../persistence/profile-state/access/profile-state-access-owner'
import { recordOrcadServedProfile } from './orcad-served-profile'
import { _resetWorktreeRemovalLifetimeForTests } from '../workspaces/removal/worktree-removal-lifetime'

const runs = vi.hoisted(() => {
  const runtimeArgs: unknown[][] = []
  const value: { profileStore: unknown; runtimeArgs: unknown[][]; servedProfiles: string[] } = {
    profileStore: null,
    runtimeArgs,
    servedProfiles: []
  }
  return value
})
const pairingReader = vi.hoisted(() => {
  const reader: { current?: RuntimeConstructionDependencies['getPairedDeviceName'] } = {}
  return reader
})

const state = vi.hoisted(() => {
  const started: {
    controller: RuntimeMobileNotificationController | null
    registry: DeviceRegistry | null
  } = { controller: null, registry: null }
  return {
    root: '',
    ...started,
    rpcStarted: false,
    profileStartupErrors: new Array<Error>(),
    onSettingsChanged: vi.fn<ProfilePreferences['onSettingsChanged']>(),
    removeSettingsListener: vi.fn(),
    startDaemon: vi.fn(async () => {}),
    stopDaemon: vi.fn(async () => {}),
    browserProvider: vi.fn(async () => null),
    register: vi.fn(async () => ({ ok: true, registrationId: 'headless-registration' })),
    send: vi.fn(async () => ({ ok: true, results: [] })),
    startCodexHooks: vi.fn(),
    installManagedAgentHooks: vi.fn(async () => []),
    refreshOpenCodePlugins: vi.fn(),
    adoptLoginShellAgentHomes: vi.fn(async () => {})
  }
})
const codexStart = vi.hoisted(() => {
  const value: { settledAtPublish: boolean | null } = { settledAtPublish: null }
  return value
})
const profile = vi.hoisted(() => {
  const value: { settings: Partial<GlobalSettings> } = { settings: {} }
  return value
})
// Reconciliation writes user-global agent configs; isolate it from the real home.
vi.mock('../github/workspace-links/github-issue-link-title-wiring', () => ({
  wireGitHubIssueLinkTitleFill: () => () => {}
}))
vi.mock('../codex/hooks/reconciliation/codex-hook-reconcile', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startCodexHooks: state.startCodexHooks
}))
vi.mock('../agent-hooks/installation/managed-agent-hook-controls', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  installManagedAgentHooks: state.installManagedAgentHooks
}))
vi.mock('../agent-hooks/installation/local-agent-cli-presence', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hydrateAgentCliShellPath: async () => {}
}))
vi.mock('../agent-hooks/installation/agent-home-login-shell', () => ({
  adoptLoginShellAgentHomes: state.adoptLoginShellAgentHomes
}))
vi.mock('../claude/agent-view/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: async () => {} })
}))
vi.mock('../opencode/status-hooks/opencode-status-plugin-startup-refresh', () => ({
  refreshInstalledOpenCodeStatusPlugins: state.refreshOpenCodePlugins
}))
vi.mock('./host-runtime/orcad-app-paths', () => ({
  resolveOrcadInstallRoot: () => state.root,
  resolveOrcadPath: () => state.root,
  resolveUserDataPath: () => state.root
}))
// Migration otherwise targets the real credential directory.
vi.mock('./credentials/orcad-plaintext-credential-migration', () => ({
  orcadCredentialRoot: () => state.root,
  migratePlaintextCredentials: () => ({ sealed: 0, failed: 0 })
}))
vi.mock('./account-launch/orcad-account-services', () => ({
  createOrcadAccountServices: () => null
}))
vi.mock('./browser-providers/orcad-browser-provider', () => ({
  resolveOrcadBrowserProvider: state.browserProvider
}))
vi.mock('./instance-lock/orcad-instance-lock', () => ({
  acquireOrcadInstanceLock: () => ({
    path: join(state.root, 'orcad.lock'),
    record: { pid: process.pid, startedAtMs: null, nonce: 'headless-instance' },
    release() {}
  })
}))
vi.mock('./daemon/orcad-daemon-supervision', () => ({
  startOrcadDaemon: state.startDaemon,
  stopOrcadDaemon: state.stopDaemon
}))
vi.mock('./diagnostics/orcad-health', () => ({ collectOrcadHealth: async () => ({}) }))
// The connector and relay have their own tests; this file covers push startup.
vi.mock('./orcad-connector', () => ({
  installOrcadConnector: () => ({ connect: () => {} })
}))
vi.mock('./orcad-relay', () => ({
  createOrcadRelay: () => ({ accountChanged: () => {}, signOutStarted: () => {}, start: () => {} })
}))
vi.mock('./host-runtime/orcad-automations', () => ({
  startOrcadAutomations: () => {},
  stopOrcadAutomationScheduler: () => {},
  orcadAutomationsKeepHostBusy: () => false
}))
// Prevent network rule downloads in this unit test.
vi.mock('../runtime/agent-state-rules/agent-state-rules-live-update', () => ({
  startAgentStateRulesLiveUpdates: () => {}
}))
vi.mock('../daemon/providers/lifecycle/daemon-provider-state', () => ({
  daemonOwnsFreshPersistentPtys: () => false
}))
vi.mock('../ipc/pty/register-headless-runtime', () => ({
  registerHeadlessPtyRuntime: async () => {}
}))
vi.mock('../ipc/pty/provider/registry', () => ({ getLocalPtyProvider: () => null }))
vi.mock('./host-runtime/orcad-usage-service', () => ({
  installOrcadUsageService: () => ({ claudeUsage: {}, codexUsage: {} })
}))
vi.mock('./profile-state/orcad-profile-state-startup', () => ({
  createOrcadProfileStateStartup: async () => {
    const error = state.profileStartupErrors.shift()
    if (error) {
      throw error
    }
    runs.profileStore = {
      getSettings: () => profile.settings,
      onSettingsChanged: state.onSettingsChanged,
      flushPendingOrThrowAsync: async () => {},
      flushFinalOrThrowAsync: async () => {},
      freezeWritesAsync: async () => {},
      // Read by startup's interrupted-deletion load; no repos means no records to keep.
      getProfileStorageDirectory: () => state.root,
      getRepos: () => []
    }
    recordOrcadServedProfile('headless-profile')
    return {
      store: runs.profileStore,
      authority: {
        backend: 'sqlite',
        classification: 'neither',
        authority_mode: 'sqlite-candidate',
        runtime: 'orcad',
        migrated: false
      }
    }
  }
}))
vi.mock('../orca-profiles/profile-index-store', () => ({
  initOrcaProfilePaths() {},
  ensureActiveOrcaProfile: () => ({
    dataFile: join(state.root, 'profile.json'),
    stateDatabaseFile: join(state.root, 'profile-state.db'),
    profile: { id: 'headless-profile' }
  })
}))
vi.mock('../ssh/host-keys/ssh-host-key-store', () => ({ initSshHostKeyStoreFile() {} }))
vi.mock('../server/serve-readiness', () => ({
  ServeReadinessPublisher: class {
    async publish() {
      const startAfter: Promise<void> | undefined =
        state.startCodexHooks.mock.calls[0]?.[0]?.startAfter
      if (startAfter) {
        let settled = false
        void startAfter.then(() => {
          settled = true
        })
        await new Promise((resolve) => setImmediate(resolve))
        codexStart.settledAtPublish = settled
      }
    }
  }
}))
// Speech warmup keeps its own settings listener for the process; these cases follow the hooks one.
vi.mock('../speech/speech-model-warmup', () => ({ startSpeechModelWarmup: vi.fn() }))
vi.mock('../runtime/orca-runtime', () => ({
  OrcaRuntimeService: class {
    constructor(store: unknown, stats: unknown, deps: RuntimeConstructionDependencies) {
      runs.runtimeArgs.push([store, stats, deps])
      pairingReader.current = deps.getPairedDeviceName
    }
    readonly sidebarFacts = null
    readonly agentTransitions = { seedRestoredRows() {} }
    readonly terminalUpdateAdmission = { holdUntilExit() {} }
    serveOrcaProfile(profileId: string) {
      runs.servedProfiles.push(profileId)
    }
    attachAgentStatusStore() {
      return () => {}
    }
    setEmulatorBridge() {}
    getRuntimeId() {
      return 'headless-runtime'
    }
    rehydrateClientHostedBrowserPages() {}
    beginStructuredAgentSessionStartupOpen() {}
    startPullRequestWatches() {}
    getEmulatorBridge() {
      return null
    }
    finishInterruptedWorktreeRemovals() {}
    onClientEvent() {
      return () => {}
    }
    restoreHostAccountLaunchEnv() {}
    async refreshRestoredOrchestrationAuthority() {}
    async reconcileLegacyWorkerTerminals() {}
    async installPendingOrcadMigrationShellHistory() {}
    async stopLegacyWorkerTerminalRecovery() {}
    async closeNotificationDismissals() {}
    flushPaneGrids() {
      return null
    }
    syncWindowGraph() {}
    setAgentSenderPeerKey() {}
    setMobilePushRegistrar(
      registrar: Parameters<RuntimeMobileNotificationController['setPushRegistrar']>[0]
    ) {
      state.controller!.setPushRegistrar(registrar)
    }
    onNotificationDispatched(
      listener: Parameters<RuntimeMobileNotificationController['onDispatched']>[0]
    ) {
      return state.controller!.onDispatched(listener)
    }
  }
}))
vi.mock('../runtime/rpc/server/runtime-rpc', () => ({
  OrcaRuntimeRpcServer: class {
    async start() {
      state.rpcStarted = true
    }
    async stop() {
      state.rpcStarted = false
    }
    getWebSocketEndpoint() {
      return null
    }
    getE2EEKeypair() {
      expect(state.rpcStarted).toBe(true)
      return createPushHostKeypair()
    }
    getDeviceRegistry() {
      return state.registry
    }
    getPushUnregisterOutbox() {
      return new PushUnregisterOutbox(state.root)
    }
    setOnPushUnregisterQueued() {}
  }
}))
vi.mock('../runtime/push/push-gateway-client', () => ({
  PushGatewayClient: class {
    registerDevice = state.register
    send = state.send
    async deleteDevice() {
      return { deleted: true, retryable: false }
    }
  }
}))

beforeEach(() => {
  // Each start's cleanup closes the module's removal lifetime; a fresh one stands in for a new process.
  _resetWorktreeRemovalLifetimeForTests()
  // Restore the prior data-root env after startOrcad canonicalizes it.
  vi.stubEnv('ORCA_USER_DATA_PATH', '')
  state.onSettingsChanged.mockReturnValue(state.removeSettingsListener)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(state.root, { recursive: true, force: true })
  state.profileStartupErrors.length = 0
  profile.settings = {}
  runs.runtimeArgs.length = 0
  runs.servedProfiles.length = 0
  codexStart.settledAtPublish = null
  vi.clearAllMocks()
})

it('refuses recovery overlap before initializing the browser provider or runtime', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-recovery-'))
  const maintenance = acquireProfileStateMaintenance(state.root)
  const { startOrcad } = await import('./host-runtime/orcad-entry')
  try {
    await expect(startOrcad({ noPairing: true, json: true })).rejects.toThrow()
    expect(state.browserProvider).not.toHaveBeenCalled()
    expect(state.rpcStarted).toBe(false)
  } finally {
    maintenance.release()
  }
})

it('reads live pairing names from the standalone RPC registry', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-names-'))
  state.controller = new RuntimeMobileNotificationController()
  state.registry = new DeviceRegistry(state.root)
  const { startOrcad } = await import('./host-runtime/orcad-entry')
  const host = await startOrcad({ noPairing: true, json: true })
  try {
    const desktop = state.registry.addDevice('Work Mac', 'runtime')
    const [phone] = state.registry.upsertDelegatedMobileDevices(desktop, [
      { phoneKey: 'phone-1', name: 'My iPhone' }
    ])
    expect(pairingReader.current?.(desktop.deviceId)).toBe('Work Mac')
    expect(pairingReader.current?.(phone!.deviceId)).toBe('My iPhone')
    state.registry.upsertDelegatedMobileDevices(desktop, [
      { phoneKey: 'phone-1', name: 'Renamed iPhone' }
    ])
    expect(pairingReader.current?.(phone!.deviceId)).toBe('Renamed iPhone')
    expect(pairingReader.current?.('unpaired')).toBeNull()
  } finally {
    await host.stop()
  }
})

it('starts push after RPC identity is available and stops dispatch on shutdown', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-push-'))
  state.controller = new RuntimeMobileNotificationController()
  state.registry = new DeviceRegistry(state.root)
  const phone = state.registry.addDevice('headless-phone', 'mobile')
  const { startOrcad } = await import('./host-runtime/orcad-entry')
  const host = await startOrcad({ noPairing: true, json: true })
  try {
    const result = await state.controller.registerPushDevice({
      deviceId: phone.deviceId,
      platform: 'android',
      token: 'test-token',
      filter: {
        onlyWhenDesktopAway: true
      }
    })
    expect(result).toMatchObject({ registered: true })
    expect(state.registry.getDevice(phone.deviceId)?.pushRegistration?.expiresAt).toBeGreaterThan(
      Date.now()
    )
    state.controller.dispatch({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'QA',
      body: 'QA'
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(state.send).toHaveBeenCalledTimes(1)
  } finally {
    await host.stop()
  }
  expect(readdirSync(profileStateAccessPaths(state.root).participants)).toEqual([])
  acquireProfileStateMaintenance(state.root).release()
  expect(state.controller.getListenerCount()).toBe(0)
  expect(state.rpcStarted).toBe(false)
  expect(state.onSettingsChanged).toHaveBeenCalledOnce()
  expect(state.removeSettingsListener).toHaveBeenCalledOnce()
  await host.stop()
  expect(state.removeSettingsListener).toHaveBeenCalledOnce()
  const phoneAfterStop = {
    deviceId: 'phone-after-stop',
    platform: 'android' as const,
    token: 't',
    filter: {}
  }
  expect(await state.controller.registerPushDevice(phoneAfterStop)).toMatchObject({
    registered: false
  })
})

it('releases admission when host setup fails before a runtime exists', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-setup-failure-'))
  state.profileStartupErrors.push(new Error('profile startup failed'))
  const { startOrcad } = await import('./host-runtime/orcad-entry')
  await expect(startOrcad()).rejects.toThrow('profile startup failed')
  expect(readdirSync(profileStateAccessPaths(state.root).participants)).toEqual([])
  acquireProfileStateMaintenance(state.root).release()
})

it('serves RPC without waiting for browser discovery', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-browser-pending-'))
  let finishDiscovery!: () => void
  state.browserProvider.mockReturnValueOnce(
    new Promise<null>((resolve) => {
      finishDiscovery = () => resolve(null)
    })
  )
  const { startOrcad } = await import('./host-runtime/orcad-entry')
  const host = await startOrcad({ noPairing: true, json: true })
  expect(host.managedStop).toMatchObject({
    runtimeId: 'headless-runtime',
    instance: { pid: process.pid, nonce: 'headless-instance' }
  })
  finishDiscovery()
  await host.stop()
  expect(readdirSync(profileStateAccessPaths(state.root).participants)).toEqual([])
})

it('unsubscribes settings when daemon startup fails after hook setup', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-daemon-failure-'))
  state.startDaemon.mockRejectedValueOnce(new Error('daemon setup failed'))
  const { startOrcad } = await import('./host-runtime/orcad-entry')
  await expect(startOrcad()).rejects.toThrow('daemon setup failed')
  expect(state.onSettingsChanged).toHaveBeenCalledOnce()
  expect(state.removeSettingsListener).toHaveBeenCalledOnce()
  expect(readdirSync(profileStateAccessPaths(state.root).participants)).toEqual([])
  acquireProfileStateMaintenance(state.root).release()
})

it('spawns the daemon while the hook server is still starting', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-daemon-parallel-'))
  const { agentHookServer } = await import('../agent-hooks/server/agent-hook-server')
  const hookStart = Promise.withResolvers<void>()
  const start = vi.spyOn(agentHookServer, 'start').mockReturnValue(hookStart.promise)
  const { startOrcad } = await import('./host-runtime/orcad-entry')
  const starting = startOrcad({ noPairing: true, json: true })

  await vi.waitFor(() => expect(start).toHaveBeenCalledOnce())
  await vi.waitFor(() => expect(state.startDaemon).toHaveBeenCalledOnce())
  hookStart.resolve()

  const host = await starting
  await host.stop()
})

it('disconnects a daemon still spawning only after it settles, when the hook server fails', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-hook-failure-'))
  const daemonSpawn = Promise.withResolvers<void>()
  state.startDaemon.mockReturnValueOnce(daemonSpawn.promise)
  const { agentHookServer } = await import('../agent-hooks/server/agent-hook-server')
  vi.spyOn(agentHookServer, 'start').mockRejectedValueOnce(new Error('hook port taken'))
  const { startOrcad } = await import('./host-runtime/orcad-entry')

  const starting = startOrcad()
  await vi.waitFor(() => expect(state.startDaemon).toHaveBeenCalledOnce())
  // The cleanup waits on the in-flight spawn rather than disconnecting a half-started provider.
  await new Promise((resolve) => setImmediate(resolve))
  expect(state.stopDaemon).not.toHaveBeenCalled()
  daemonSpawn.resolve()

  await expect(starting).rejects.toThrow('hook port taken')
  expect(state.stopDaemon).toHaveBeenCalledOnce()
  acquireProfileStateMaintenance(state.root).release()
})

it('disconnects the daemon when startup throws between its spawn and the stores', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-early-throw-'))
  const observability = await import('./diagnostics/orcad-observability')
  vi.spyOn(observability, 'installOrcadObservability').mockImplementationOnce(() => {
    throw new Error('observability init failed')
  })
  const { startOrcad } = await import('./host-runtime/orcad-entry')

  await expect(startOrcad()).rejects.toThrow('observability init failed')

  expect(state.startDaemon).toHaveBeenCalledOnce()
  expect(state.stopDaemon).toHaveBeenCalledOnce()
})

it('installs agent status hooks on the host when it starts', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-hooks-'))
  const { startOrcad } = await import('./host-runtime/orcad-entry')
  const host = await startOrcad({ noPairing: true, json: true })
  try {
    expect(state.startCodexHooks).toHaveBeenCalledOnce()
    expect(state.startCodexHooks.mock.calls[0]![0].resolveLaunchHome()).toBeNull()
    // Codex's PATH scan waits for readiness to publish, then runs.
    expect(codexStart.settledAtPublish).toBe(false)
    await state.startCodexHooks.mock.calls[0]![0].startAfter
    await vi.waitFor(() =>
      expect(state.installManagedAgentHooks).toHaveBeenCalledWith(
        profile.settings,
        expect.objectContaining({ shouldHydrateShellPath: true })
      )
    )
    expect(state.refreshOpenCodePlugins).toHaveBeenCalledWith(profile.settings)
    expect(state.adoptLoginShellAgentHomes.mock.invocationCallOrder[0]).toBeLessThan(
      state.installManagedAgentHooks.mock.invocationCallOrder[0]!
    )
  } finally {
    await host.stop()
  }
})

it('leaves agent configs alone when status hooks are off', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-hooks-off-'))
  profile.settings = { agentStatusHooksEnabled: false }
  const { startOrcad } = await import('./host-runtime/orcad-entry')
  const host = await startOrcad({ noPairing: true, json: true })
  try {
    await new Promise((resolve) => setImmediate(resolve))
    expect(state.installManagedAgentHooks).not.toHaveBeenCalled()
    expect(state.startCodexHooks.mock.calls[0]![0].isEnabled()).toBe(false)
  } finally {
    await host.stop()
  }
})

// Bots record link owners from this profile's account; it must be the one whose store this is.
it("serves the startup profile's store and names that same profile", async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-served-profile-'))
  const { startOrcad } = await import('./host-runtime/orcad-entry')
  const host = await startOrcad({ noPairing: true, json: true })
  try {
    const [store] = runs.runtimeArgs[0] ?? []
    expect(store).toBe(runs.profileStore)
    expect(runs.servedProfiles).toEqual(['headless-profile'])
  } finally {
    await host.stop()
  }
})
