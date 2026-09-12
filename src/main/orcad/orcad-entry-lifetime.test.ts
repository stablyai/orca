import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as fs from 'node:fs'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { startOrcad } from './orcad-entry'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    realpathSync: (path: string) => (path.startsWith('/test/') ? path : actual.realpathSync(path))
  }
})

const state = vi.hoisted(() => ({
  events: [] as string[],
  fail: '',
  bridgeOptions: [] as unknown[],
  browserWait: undefined as Promise<void> | undefined,
  cleanupFailures: new Set<string>(),
  runtimeOptions: undefined as ConstructorParameters<typeof OrcaRuntimeService>[2],
  observedStatus: null as ((event: { paneKey: string }) => void) | null
}))
function step(name: string) {
  state.events.push(name)
  if (state.fail === name || state.cleanupFailures.has(name)) {
    throw new Error(name)
  }
}

vi.mock('../../shared/app-environment', () => ({
  setAppEnvironment: (env: { onWillQuit: (fn: () => void) => void }) => {
    env.onWillQuit(() => step('quit'))
  },
  getAppEnvironment: () => ({
    getPath: () => '/test',
    getVersion: () => 'test',
    isPackaged: () => true
  })
}))
vi.mock('../../shared/secret-store', () => ({ setSecretStore: vi.fn() }))
vi.mock('../ssh/profile-lifetime-admission', () => ({
  initializeProfileLifetimeAdmission: () => step('profile.admission')
}))
vi.mock('./orcad-app-paths', () => ({
  resolveUserDataPath: () => '/test',
  resolveOrcadPath: () => '/test',
  resolveOrcadInstallRoot: () => '/test'
}))
vi.mock('./orcad-instance-lock', () => ({
  acquireOrcadInstanceLock: () => {
    step('lock')
    return {
      path: '/test/orcad.lock',
      record: { pid: 123, startedAtMs: 1, nonce: 'startup-instance' },
      release: () => step('release')
    }
  },
  OrcadInstanceLockError: class extends Error {}
}))
vi.mock('./orcad-browser-provider', () => ({
  resolveOrcadBrowserProvider: async () => {
    step('browser')
    await state.browserWait
    return { factory: {}, isAvailable: () => true, stop: async () => step('browser.stop') }
  }
}))
vi.mock('../runtime/runtime-browser-commands-factory', () => ({
  setRuntimeBrowserCommandsFactory: (value: unknown) => step(value ? 'factory' : 'factory.clear')
}))
vi.mock('../runtime/orca-runtime', () => ({
  OrcaRuntimeService: class {
    constructor(_store: unknown, _stats: unknown, options: typeof state.runtimeOptions) {
      state.runtimeOptions = options
      step('runtime')
    }
    installPtyOwnershipTransferDestinationOutputBridge(options: unknown) {
      state.bridgeOptions.push(options)
    }
    rehydrateClientHostedBrowserPages() {}
    recoverPtyOwnershipTransferDestinations() {}
    installCapturedPtyDestinationLifecycle() {
      step('captured.install')
      return () => step('captured.dispose')
    }
    getPtyOwnershipTransferDestinationRegistry() {
      return {
        recoverPersistedDelegatedDestinations: () => {
          step('delegated.discover')
          return []
        }
      }
    }
    async refreshRestoredOrchestrationAuthority() {}
    async reconcileLegacyWorkerTerminals() {
      step('workers.recovered')
    }
    async stopLegacyWorkerTerminalRecovery() {}
    getAgentStatusTerminalHandleForPaneKey() {
      step('status.identity')
      return 'terminal'
    }
    getTerminalProcessIncarnation() {
      return 'pty:incarnation'
    }
    getAgentStatusOrchestrationContextForPaneKey() {
      return { dispatchId: 'dispatch' }
    }
    getRuntimeId() {
      return 'runtime'
    }
  }
}))
vi.mock('../runtime/runtime-rpc', () => ({
  OrcaRuntimeRpcServer: class {
    async start() {
      step('rpc')
    }
    async stop() {
      step('rpc.stop')
    }
    getWebSocketEndpoint() {
      return null
    }
    createPairingOffer() {
      return { available: false }
    }
  }
}))
vi.mock('../ipc/pty', () => ({
  registerHeadlessPtyRuntime: async () => step('headless'),
  getLocalPtyProvider: vi.fn(),
  getSshPtyProvider: vi.fn(),
  subscribeLocalPtyProviderChanges: vi.fn()
}))
vi.mock('../runtime/pairing-endpoint', () => ({ resolveAdvertisedPairingEndpoint: vi.fn() }))
vi.mock('../server/serve-readiness', () => ({
  ServeReadinessPublisher: class {
    async publish() {
      step('readiness')
    }
  }
}))
vi.mock('../persistence/loading-store/store', () => ({
  Store: class {
    getSettings() {
      return {}
    }
  }
}))
vi.mock('../agent-hooks/server', () => ({
  agentHookServer: {
    subscribeEnrichedStatus: (listener: typeof state.observedStatus) => {
      state.observedStatus = listener
      return () => {
        state.observedStatus = null
        step('status.unsubscribe')
      }
    },
    start: async () => {
      step('hooks.start')
      state.observedStatus?.({ paneKey: 'pane' })
    },
    stop: () => step('hooks.stop')
  }
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  isAgentStatusHooksEnabled: () => true
}))
vi.mock('../agent-hooks/hook-status-session-tabs-republish', () => ({
  installHookStatusSessionTabsRepublish: () => {
    step('status.republish')
    return () => step('status.republish.stop')
  }
}))
vi.mock('../runtime/push/desktop-push-service', () => ({
  DesktopPushService: {
    create: () => ({ start: () => step('push.start'), stop: () => step('push.stop') })
  }
}))
vi.mock('../orca-profiles/profile-index-store', () => ({
  initOrcaProfilePaths: vi.fn(),
  ensureActiveOrcaProfile: () => ({
    profile: { id: 'profile' },
    profileDirectory: '/test/profile',
    dataFile: '/test/data'
  })
}))
vi.mock('../ssh/ssh-host-key-store', () => ({ initSshHostKeyStoreFile: vi.fn() }))
vi.mock('./orcad-daemon-supervision', () => ({
  startOrcadDaemon: async () => step('daemon'),
  stopOrcadDaemon: async () => step('daemon.stop'),
  decommissionOrcadDaemonIfIdle: vi.fn()
}))
vi.mock('../daemon/daemon-init', () => ({ daemonOwnsFreshPersistentPtys: vi.fn() }))
vi.mock('./orcad-health', () => ({ collectOrcadHealth: vi.fn() }))
vi.mock('./orcad-decommission', () => ({
  configureOrcadDecommission: (value: unknown) =>
    step(value ? 'decommission' : 'decommission.clear')
}))
vi.mock('../runtime/runtime-identity', () => ({ loadOrCreateRuntimeIdentity: () => 'runtime' }))
vi.mock('../providers/runtime-pty-ownership-transfer-read-only-source', () => ({
  RuntimePtyOwnershipTransferReadOnlySource: class {},
  createReconciledRuntimePtyOwnershipTransferReadOnlySource: async () => ({
    source: { dispose: () => step('source.stop') },
    unsubscribe: () => step('source.unsubscribe')
  })
}))

beforeEach(() => {
  vi.stubEnv('ORCA_ENABLE_PTY_OWNERSHIP_TRANSFER_MUTATION', undefined)
  state.events = []
  state.fail = ''
  state.bridgeOptions = []
  state.browserWait = undefined
  state.runtimeOptions = undefined
  state.observedStatus = null
  state.cleanupFailures.clear()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it.each([
  'factory',
  'hooks.start',
  'daemon',
  'runtime',
  'headless',
  'rpc',
  'push.start',
  'readiness'
])(
  'unwinds acquired resources after %s startup failure and preserves the original error',
  async (failure) => {
    state.fail = failure
    await expect(startOrcad()).rejects.toThrow(failure)
    expect(state.events.at(-1)).toBe('release')
    expect(state.events.filter((name) => name === 'release')).toHaveLength(1)
    expect(state.events).toContain('quit')
    if (failure !== 'factory') {
      expect(state.events).toContain('browser.stop')
    }
    if (!['browser', 'factory', 'hooks.start'].includes(failure)) {
      expect(state.events).toContain('daemon.stop')
    }
    if (['rpc', 'push.start', 'readiness'].includes(failure)) {
      expect(state.events).toContain('rpc.stop')
    }
  }
)

it('serves core RPC while optional browser discovery is still pending', async () => {
  const browser = Promise.withResolvers<void>()
  state.browserWait = browser.promise
  const handle = await startOrcad()
  expect(state.events).toContain('readiness')
  expect(state.events).not.toContain('browser.stop')
  const stopping = handle.stop()
  await Promise.resolve()
  expect(state.events).not.toContain('release')
  browser.resolve()
  await stopping
  expect(state.events.indexOf('browser.stop')).toBeLessThan(state.events.indexOf('release'))
})

it('refuses startup before browser or runtime work when profile admission fails', async () => {
  state.fail = 'profile.admission'
  await expect(startOrcad()).rejects.toThrow('profile.admission')
  expect(state.events).toContain('release')
  expect(state.events).not.toContain('browser')
  expect(state.events).not.toContain('runtime')
  expect(state.events).not.toContain('readiness')
})

it('stops a successful runtime once, in dependency order', async () => {
  const handle = await startOrcad()
  expect(state.events.indexOf('decommission')).toBeLessThan(state.events.indexOf('readiness'))
  state.events = []
  const stopping = handle.stop()
  expect(handle.stop()).toBe(stopping)
  await stopping
  expect(state.events).toEqual([
    'decommission.clear',
    'push.stop',
    'rpc.stop',
    'status.republish.stop',
    'source.unsubscribe',
    'source.stop',
    'daemon.stop',
    'status.unsubscribe',
    'hooks.stop',
    'browser.stop',
    'factory.clear',
    'quit',
    'release'
  ])
})

it('continues shutdown after failures but does not release the single-writer lock', async () => {
  const handle = await startOrcad()
  state.events = []
  state.cleanupFailures = new Set(['rpc.stop', 'daemon.stop', 'browser.stop'])
  await expect(handle.stop()).rejects.toMatchObject({ message: 'orcad_runtime_cleanup_failed' })
  expect(state.events).toEqual([
    'decommission.clear',
    'push.stop',
    'rpc.stop',
    'status.republish.stop',
    'source.unsubscribe',
    'source.stop',
    'daemon.stop',
    'status.unsubscribe',
    'hooks.stop',
    'browser.stop',
    'factory.clear',
    'quit'
  ])
})

it('preserves the startup error when cleanup also fails and retains the lock', async () => {
  state.fail = 'readiness'
  state.cleanupFailures.add('rpc.stop')
  await expect(startOrcad()).rejects.toThrow('readiness')
  expect(state.events).toContain('daemon.stop')
  expect(state.events).toContain('browser.stop')
  expect(state.events).not.toContain('release')
})

it('captures replayed status identity after worker recovery and starts push after RPC', async () => {
  const handle = await startOrcad()
  try {
    expect(state.events.indexOf('status.identity')).toBeGreaterThan(
      state.events.indexOf('workers.recovered')
    )
    expect(state.events.indexOf('push.start')).toBeGreaterThan(state.events.indexOf('rpc'))
    expect(state.runtimeOptions?.readObservedAgentStatusPaneIdentity?.('pane')).toEqual({
      kind: 'observed',
      terminalHandle: 'terminal',
      processIncarnation: 'pty:incarnation',
      dispatchId: 'dispatch'
    })
  } finally {
    await handle.stop()
  }
  expect(state.observedStatus).toBeNull()
})

it('retains the lock when a registered quit handler fails', async () => {
  const handle = await startOrcad()
  state.cleanupFailures.add('quit')
  await expect(handle.stop()).rejects.toMatchObject({ message: 'orcad_runtime_cleanup_failed' })
  expect(state.events).not.toContain('release')
})

it.each(['push.stop', 'hooks.stop', 'status.unsubscribe', 'status.republish.stop'])(
  'drains other resources and retains the lock when %s fails',
  async (failure) => {
    const handle = await startOrcad()
    state.events = []
    state.cleanupFailures.add(failure)
    await expect(handle.stop()).rejects.toThrow('orcad_runtime_cleanup_failed')
    expect(state.events).toEqual(
      expect.arrayContaining(['rpc.stop', 'daemon.stop', 'browser.stop'])
    )
    expect(state.events).not.toContain('release')
  }
)

it.each(['0', '1'])('production startup enforces delegated recovery gate=%s', async (gate) => {
  vi.stubEnv('ORCA_ENABLE_PTY_OWNERSHIP_TRANSFER_MUTATION', gate)
  const handle = await startOrcad()
  if (gate === '1') {
    expect(state.events.indexOf('delegated.discover')).toBeGreaterThan(
      state.events.indexOf('headless')
    )
    expect(state.events.indexOf('delegated.discover')).toBeLessThan(state.events.indexOf('rpc'))
  } else {
    expect(state.events).not.toContain('delegated.discover')
  }
  await handle.stop()
  expect(state.events.at(-1)).toBe('release')
})

it('unwinds startup without serving RPC when delegated discovery cannot prove durability', async () => {
  vi.stubEnv('ORCA_ENABLE_PTY_OWNERSHIP_TRANSFER_MUTATION', '1')
  state.fail = 'delegated.discover'
  await expect(startOrcad()).rejects.toThrow('delegated.discover')
  expect(state.events).not.toContain('rpc')
  expect(state.events).toContain('daemon.stop')
  expect(state.events.at(-1)).toBe('release')
})

it.each([undefined, 'true', '0', '1'])(
  'enables catalog publication only for the exact canary value %s',
  async (gate) => {
    vi.stubEnv('ORCA_ENABLE_PTY_OWNERSHIP_TRANSFER_MUTATION', gate)
    const handle = await startOrcad()
    try {
      expect(state.bridgeOptions).toEqual([gate === '1' ? { catalogPublicationVersion: 1 } : {}])
    } finally {
      await handle.stop()
    }
    expect(state.events.at(-1)).toBe('release')
  }
)
