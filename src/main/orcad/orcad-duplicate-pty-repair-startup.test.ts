import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { PersistedState } from '../../shared/persisted-state-types'
import { agentHookServer } from '../agent-hooks/server'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore
} from '../persistence/terminal-topology/terminal-topology-profile-fixture'
import { DelayedAuthority } from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import { Store } from '../persistence/loading-store/store'
import {
  leafIds,
  WindowSession
} from '../persistence/terminal-topology/terminal-topology-window-session-fixture'

const state = vi.hoisted(() => {
  const value: {
    root: string
    store: Store | null
    layoutOwnerIsMain: boolean
    rekeyWorkerTerminalResourcePaneKey: Mock<() => number>
    onStartupStep: ((step: string) => void) | null
    placementRejects: boolean
  } = {
    root: '',
    store: null,
    layoutOwnerIsMain: true,
    rekeyWorkerTerminalResourcePaneKey: vi.fn(() => 1),
    onStartupStep: null,
    placementRejects: false
  }
  return value
})

vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return state.layoutOwnerIsMain
  }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
// Isolate reconciliation from the developer’s real global agent configs.
vi.mock('../codex/codex-hook-reconcile', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  startCodexHooks: vi.fn()
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  installManagedAgentHooks: vi.fn(async () => [])
}))
vi.mock('../agent-hooks/local-agent-cli-presence', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hydrateAgentCliShellPath: async () => {}
}))
vi.mock('../agent-hooks/agent-home-login-shell', () => ({
  adoptLoginShellAgentHomes: async () => {}
}))
vi.mock('../opencode/opencode-status-plugin-startup-refresh', () => ({
  refreshInstalledOpenCodeStatusPlugins: vi.fn()
}))
vi.mock('./orcad-app-paths', () => ({
  resolveOrcadInstallRoot: () => state.root,
  resolveOrcadPath: () => state.root,
  resolveUserDataPath: () => state.root
}))
vi.mock('./orcad-plaintext-credential-migration', () => ({
  orcadCredentialRoot: () => state.root,
  migratePlaintextCredentials: () => ({ sealed: 0, failed: 0 })
}))
vi.mock('./orcad-account-services', () => ({ createOrcadAccountServices: () => null }))
vi.mock('./orcad-browser-provider', () => ({ resolveOrcadBrowserProvider: async () => null }))
vi.mock('./orcad-instance-lock', () => ({
  acquireOrcadInstanceLock: () => ({
    path: join(state.root, 'orcad.lock'),
    record: { pid: process.pid, startedAtMs: null, nonce: 'repair-instance' },
    release() {}
  })
}))
vi.mock('./orcad-daemon-supervision', () => ({
  startOrcadDaemon: async () => {},
  stopOrcadDaemon: async () => {}
}))
vi.mock('./orcad-health', () => ({ collectOrcadHealth: async () => ({}) }))
vi.mock('./orcad-automations', () => ({
  startOrcadAutomations: () => {},
  stopOrcadAutomationScheduler: () => {},
  orcadAutomationsKeepHostBusy: () => false
}))
vi.mock('../runtime/agent-state-rules/agent-state-rules-live-update', () => ({
  startAgentStateRulesLiveUpdates: () => {}
}))
vi.mock('../daemon/daemon-provider-state', () => ({ daemonOwnsFreshPersistentPtys: () => false }))
vi.mock('../ipc/pty/register-headless-runtime', () => ({
  registerHeadlessPtyRuntime: async () => {}
}))
vi.mock('../ipc/pty/provider/registry', () => ({ getLocalPtyProvider: () => null }))
vi.mock('./orcad-profile-state-startup', () => ({
  createOrcadProfileStateStartup: async () => ({
    store: state.store,
    authority: {
      backend: 'sqlite',
      classification: 'neither',
      authority_mode: 'sqlite-candidate',
      runtime: 'orcad',
      migrated: false
    }
  })
}))
vi.mock('../orca-profiles/profile-index-store', () => ({
  initOrcaProfilePaths() {},
  ensureActiveOrcaProfile: () => ({
    dataFile: join(state.root, 'profile.json'),
    stateDatabaseFile: join(state.root, 'profile-state.db'),
    profile: { id: 'repair-profile' }
  })
}))
vi.mock('../ssh/ssh-host-key-store', () => ({ initSshHostKeyStoreFile() {} }))
vi.mock('../server/serve-readiness', () => ({
  ServeReadinessPublisher: class {
    async publish() {}
  }
}))
vi.mock('../runtime/push/desktop-push-service', () => ({
  DesktopPushService: { create: () => null }
}))
vi.mock('../runtime/orca-runtime', () => ({
  OrcaRuntimeService: class {
    readonly sidebarFacts = null
    readonly agentTransitions = { seedRestoredRows() {} }
    attachAgentStatusStore() {
      return () => {}
    }
    setEmulatorBridge() {}
    getRuntimeId() {
      return 'repair-runtime'
    }
    getExistingOrchestrationDb() {
      return { rekeyWorkerTerminalResourcePaneKey: state.rekeyWorkerTerminalResourcePaneKey }
    }
    rehydrateClientHostedBrowserPages() {}
    restoreHostAccountLaunchEnv() {}
    async refreshRestoredOrchestrationAuthority() {}
    async reconcileLegacyWorkerTerminals() {
      state.onStartupStep?.('reconcile')
    }
    async placeUnshownLiveTerminals() {
      state.onStartupStep?.('place')
      if (state.placementRejects) {
        throw new Error('census record unreadable')
      }
      return { placed: [], declined: [] }
    }
    async installPendingOrcadMigrationShellHistory() {}
    async stopLegacyWorkerTerminalRecovery() {}
    flushPaneGrids() {
      return null
    }
    async closeNotificationDismissals() {}
    syncWindowGraph() {}
  }
}))
vi.mock('../runtime/runtime-rpc', () => ({
  OrcaRuntimeRpcServer: class {
    async start() {
      state.onStartupStep?.('rpc.start')
    }
    async stop() {}
    getWebSocketEndpoint() {
      return null
    }
  }
}))

const TAB = 'tab-1'
const KEPT = '11111111-1111-4111-8111-111111111111'
const DUPLICATE = '22222222-2222-4222-8222-222222222222'
const directories: string[] = []

beforeEach(() => {
  vi.stubEnv('ORCA_USER_DATA_PATH', '')
})

afterEach(() => {
  state.layoutOwnerIsMain = true
  state.onStartupStep = null
  state.placementRejects = false
  state.rekeyWorkerTerminalResourcePaneKey.mockClear()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

function duplicatePtyProfile(): string {
  const window = new WindowSession(getDefaultWorkspaceSession())
  window.addTab(FIXTURE_GIT_WORKTREE_ID, TAB, KEPT)
  window.setLayout(
    TAB,
    {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: KEPT },
      second: { type: 'leaf', leafId: DUPLICATE }
    },
    { [KEPT]: 'pty-1', [DUPLICATE]: 'pty-1' }
  )
  return JSON.stringify({
    ...JSON.parse(emptyTerminalSessionProfile()),
    workspaceSession: window.session
  })
}

function storedLeafIds(directory: string): string[] {
  const reader = new ProfileStateSqliteAuthority(join(directory, 'profile-state.db'), 'topology')
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test wrote this profile as PersistedState.
    const stored = JSON.parse(reader.readSerializedState() ?? '{}') as PersistedState
    return leafIds(stored.workspaceSession?.terminalLayoutsByTabId?.[TAB]?.root)
  } finally {
    reader.close()
  }
}

async function seedDuplicatePtyProfile(): Promise<string> {
  state.root = temporaryDirectory('orcad-duplicate-pty-repair-')
  const profileDirectory = temporaryDirectory('orcad-duplicate-pty-profile-')
  state.store = await openTopologyStore(profileDirectory, duplicatePtyProfile())
  return profileDirectory
}

it('repairs a stored duplicate-terminal pane at orcad startup, moving owners before the write', async () => {
  const profileDirectory = await seedDuplicatePtyProfile()
  const diskAtTransfer: string[][] = []
  const transfer = vi
    .spyOn(agentHookServer, 'transferPaneAuthority')
    .mockImplementation(() => diskAtTransfer.push(storedLeafIds(profileDirectory)))

  const { startOrcad } = await import('./orcad-entry')
  const host = await startOrcad({ noPairing: true, json: true })
  try {
    await vi.waitFor(() => expect(storedLeafIds(profileDirectory)).toEqual([KEPT]))
    expect(transfer).toHaveBeenCalledExactlyOnceWith(
      `${TAB}:${DUPLICATE}`,
      `${TAB}:${KEPT}`,
      'pty-1',
      expect.any(Number),
      { authorityVerified: true }
    )
    expect(state.rekeyWorkerTerminalResourcePaneKey).toHaveBeenCalledExactlyOnceWith({
      fromPaneKey: `${TAB}:${DUPLICATE}`,
      toPaneKey: `${TAB}:${KEPT}`
    })
    expect(diskAtTransfer).toEqual([[KEPT, DUPLICATE]])
  } finally {
    await host.stop()
  }
})

it('leaves the stored panes alone when the build keeps the window as layout owner', async () => {
  state.layoutOwnerIsMain = false
  const profileDirectory = await seedDuplicatePtyProfile()
  const transfer = vi.spyOn(agentHookServer, 'transferPaneAuthority')

  const { startOrcad } = await import('./orcad-entry')
  const host = await startOrcad({ noPairing: true, json: true })
  await host.stop()

  expect(transfer).not.toHaveBeenCalled()
  expect(state.rekeyWorkerTerminalResourcePaneKey).not.toHaveBeenCalled()
  expect(storedLeafIds(profileDirectory)).toEqual([KEPT, DUPLICATE])
})

it('writes the repair before reconcile and RPC even when a profile write is in flight', async () => {
  state.root = temporaryDirectory('orcad-duplicate-pty-repair-')
  const profileDirectory = temporaryDirectory('orcad-duplicate-pty-profile-')
  const inner = new ProfileStateSqliteAuthority(
    join(profileDirectory, 'profile-state.db'),
    'topology'
  )
  inner.writeSerializedState(Buffer.from(duplicatePtyProfile()))
  const authority = new DelayedAuthority(inner)
  const store = new Store({
    dataFile: join(profileDirectory, 'orca-data.json'),
    profileStateAuthority: authority
  })
  await store.flushPendingOrThrowAsync()
  state.store = store
  vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
  const diskAtStep: Record<string, string[]> = {}
  state.onStartupStep = (step) => (diskAtStep[step] = storedLeafIds(profileDirectory))

  const held = authority.pause()
  store.updateSettings({ agentStatusHooksEnabled: false })
  const heldWrite = store.flushPendingOrThrowAsync()
  await held.started.promise
  const { startOrcad } = await import('./orcad-entry')
  const startup = startOrcad({ noPairing: true, json: true })
  await new Promise((resolve) => setTimeout(resolve, 200))
  held.finish.resolve()
  await heldWrite
  const host = await startup
  try {
    expect(diskAtStep).toEqual({ reconcile: [KEPT], place: [KEPT], 'rpc.start': [KEPT] })
  } finally {
    await host.stop()
  }
})

it('still starts serving when showing live terminals fails at startup', async () => {
  await seedDuplicatePtyProfile()
  vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  state.placementRejects = true
  const steps: string[] = []
  state.onStartupStep = (step) => steps.push(step)

  const { startOrcad } = await import('./orcad-entry')
  const host = await startOrcad({ noPairing: true, json: true })
  try {
    expect(steps).toEqual(['reconcile', 'place', 'rpc.start'])
  } finally {
    await host.stop()
  }
})
