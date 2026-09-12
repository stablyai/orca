import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../runtime/device-registry'
import { RuntimeMobileNotificationController } from '../runtime/runtime-mobile-notification-controller'
import { PushUnregisterOutbox } from '../runtime/push/push-unregister-outbox'
import { createPushHostKeypair } from '../runtime/push/push-host-challenge-fixtures'

const state = vi.hoisted(() => ({
  root: '',
  controller: null as RuntimeMobileNotificationController | null,
  registry: null as DeviceRegistry | null,
  rpcStarted: false,
  register: vi.fn(async () => ({ ok: true, registrationId: 'headless-registration' })),
  send: vi.fn(async () => ({ ok: true, results: [] }))
}))
vi.mock('./orcad-app-paths', () => ({
  resolveOrcadInstallRoot: () => state.root,
  resolveOrcadPath: () => state.root,
  resolveUserDataPath: () => state.root
}))
vi.mock('./orcad-browser-provider', () => ({ resolveOrcadBrowserProvider: async () => null }))
vi.mock('./orcad-instance-lock', () => ({ acquireOrcadInstanceLock: () => ({ release() {} }) }))
vi.mock('../ssh/profile-lifetime-admission', () => ({ initializeProfileLifetimeAdmission() {} }))
vi.mock('./orcad-profile-daemon-startup', () => ({
  startOrcadProfileDaemon: async () => 'headless-runtime',
  captureOrcadManagedStopContext: () => [undefined, undefined]
}))
vi.mock('./orcad-daemon-supervision', () => ({
  startOrcadDaemon: async () => {},
  stopOrcadDaemon: async () => {},
  decommissionOrcadDaemonIfIdle: vi.fn()
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    subscribeEnrichedStatus: () => () => {},
    start: async () => {},
    stop() {}
  }
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  isAgentStatusHooksEnabled: () => false
}))
vi.mock('../agent-hooks/hook-status-session-tabs-republish', () => ({
  installHookStatusSessionTabsRepublish: () => () => {}
}))
vi.mock('../providers/runtime-pty-ownership-transfer-read-only-source', () => ({
  RuntimePtyOwnershipTransferReadOnlySource: class {},
  createReconciledRuntimePtyOwnershipTransferReadOnlySource: async () => ({
    source: { dispose() {} },
    unsubscribe() {}
  })
}))
vi.mock('./orcad-health', () => ({ collectOrcadHealth: async () => ({}) }))
vi.mock('../daemon/daemon-init', () => ({ daemonOwnsFreshPersistentPtys: () => false }))
vi.mock('../ipc/pty', () => ({
  registerHeadlessPtyRuntime: async () => {},
  getLocalPtyProvider: () => null,
  getSshPtyProvider: () => null,
  subscribeLocalPtyProviderChanges: () => () => {}
}))
vi.mock('../persistence/loading-store/store', () => ({
  Store: class {
    getSettings() {
      return {}
    }
  }
}))
vi.mock('../orca-profiles/profile-index-store', () => ({
  initOrcaProfilePaths() {},
  ensureActiveOrcaProfile: () => ({
    dataFile: join(state.root, 'profile.json'),
    profileDirectory: state.root
  })
}))
vi.mock('../ssh/ssh-host-key-store', () => ({ initSshHostKeyStoreFile() {} }))
vi.mock('../server/serve-readiness', () => ({
  ServeReadinessPublisher: class {
    async publish() {}
  }
}))
vi.mock('../runtime/orca-runtime', () => ({
  OrcaRuntimeService: class {
    getRuntimeId() {
      return 'headless-runtime'
    }
    rehydrateClientHostedBrowserPages() {}
    installPtyOwnershipTransferDestinationOutputBridge() {}
    recoverPtyOwnershipTransferDestinations() {}
    getPtyOwnershipTransferDestinationRegistry() {
      return null
    }
    async refreshRestoredOrchestrationAuthority() {}
    async reconcileLegacyWorkerTerminals() {}
    async stopLegacyWorkerTerminalRecovery() {}
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
vi.mock('../runtime/runtime-rpc', () => ({
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

afterEach(() => {
  rmSync(state.root, { recursive: true, force: true })
  vi.clearAllMocks()
})

it('starts push after RPC identity is available and stops dispatch on shutdown', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-push-'))
  state.controller = new RuntimeMobileNotificationController()
  state.registry = new DeviceRegistry(state.root)
  const phone = state.registry.addDevice('headless-phone', 'mobile')
  const { startOrcad } = await import('./orcad-entry')
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
  expect(state.controller.getListenerCount()).toBe(0)
  expect(await state.controller.registerPushDevice({} as never)).toMatchObject({
    registered: false
  })
})
