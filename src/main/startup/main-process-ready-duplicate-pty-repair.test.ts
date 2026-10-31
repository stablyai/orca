import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { PersistedState } from '../../shared/persisted-state-types'
import { agentHookServer } from '../agent-hooks/server'
import { DelayedAuthority } from '../persistence/loading-store/profile-state-delayed-authority-fixture'
import { Store } from '../persistence/loading-store/store'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID
} from '../persistence/terminal-topology/terminal-topology-profile-fixture'
import {
  leafIds,
  WindowSession
} from '../persistence/terminal-topology/terminal-topology-window-session-fixture'

const fixture = vi.hoisted(() => {
  const value: { state: Record<string, unknown>; userData: string } = {
    // Account services are stubs: this file pins only the repair's place in readiness.
    state: {
      store: null,
      stats: {},
      runtime: null,
      claudeAccounts: {},
      codexAccounts: {},
      rateLimits: {}
    },
    userData: ''
  }
  return value
})

vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('electron', () => ({
  app: { isPackaged: false, on: vi.fn(), once: vi.fn(), getPath: () => fixture.userData },
  nativeTheme: {}
}))
vi.mock('./main-process-state', () => ({ mainProcessState: fixture.state }))
vi.mock('../runtime/orca-runtime', () => ({
  OrcaRuntimeService: class {
    readonly sidebarFacts = null
    readonly agentTransitions = { seedRestoredRows() {} }
    attachAgentStatusStore() {
      return () => {}
    }
    getExistingOrchestrationDb() {
      return null
    }
    rehydrateClientHostedBrowserPages() {}
    setAgentBrowserBridge() {}
    setEmulatorBridge() {}
    setArtifactService() {}
    setSkillCloudService() {}
    setAccountServices() {}
    setCommitMessageAgentEnvironmentResolvers() {}
  }
}))
vi.mock('../runtime/agent-session/ownership/agent-session-claim-identity', () => ({
  loadAgentSessionClaimSigner: () => null
}))
vi.mock('../ai-vault-search/session-search-enablement', () => ({
  applySessionSearchSettingsChange: vi.fn(),
  installChildSessionSearchService: () => null
}))
vi.mock('../runtime/agent-state-rules/agent-state-rules-live-update', () => ({
  startAgentStateRulesLiveUpdates: () => {}
}))
vi.mock('../artifacts/artifact-cloud-service', () => ({ ArtifactCloudService: class {} }))
vi.mock('../skills/skill-cloud-service', () => ({ SkillCloudService: class {} }))
vi.mock('./wsl-orcad-account-env-wiring', () => ({ installWslOrcadAccountShim: vi.fn() }))
vi.mock('../codex/codex-hook-reconcile', () => ({ startCodexHooks: vi.fn() }))
vi.mock('../star-nag/service', () => ({
  StarNagService: class {
    start = vi.fn()
    registerIpcHandlers = vi.fn()
  }
}))
vi.mock('../browser/agent-browser-bridge', () => ({
  AgentBrowserBridge: class {
    sweepOrphanedSessions = vi.fn()
  }
}))
vi.mock('../emulator/emulator-bridge', () => ({ EmulatorBridge: class {} }))
vi.mock('../runtime/rpc/dispatcher', () => ({ RpcDispatcher: class {} }))
vi.mock('../browser/browser-manager', () => ({
  browserManager: { setBrowserGuestStateChangedListener: vi.fn() }
}))
vi.mock('../browser/browser-client-page-automation-runtime', () => ({
  configureBrowserClientPageAutomationRuntime: vi.fn()
}))
vi.mock('../crash-reporting/process-gone-diagnostics', () => ({
  startPreGoneCrashSampling: vi.fn()
}))
vi.mock('./main-window-lifecycle-flags', () => ({ recordProcessGoneCrash: vi.fn() }))
vi.mock('./gpu-lifecycle', () => ({ handleGpuChildCrash: vi.fn() }))
vi.mock('./configure-process', () => ({ shouldInstallManagedHooks: () => false }))
vi.mock('./main-process-observers', () => ({ initializeMainProcessObservers: vi.fn() }))
vi.mock('./branch-rename-hook', () => ({ installFirstWorkRenameHookSubscription: vi.fn() }))
vi.mock('./main-process-account-services', () => ({
  initializeMainProcessAccountServices: vi.fn()
}))
vi.mock('./main-process-automations', () => ({ initializeMainProcessAutomations: vi.fn() }))
vi.mock('./main-process-plugins', () => ({ initializeMainProcessPlugins: vi.fn() }))
vi.mock('../worktree-trash', () => ({
  collectWorktreeTrashSweepRoots: vi.fn(),
  sweepStaleWorktreeTrash: vi.fn()
}))
vi.mock('./worktree-removal-records-load', () => ({ loadWorktreeRemovalRecordsForStore: vi.fn() }))
vi.mock('./first-window-deferral', () => ({ runAfterFirstWindowShown: vi.fn() }))
vi.mock('./startup-diagnostics', () => ({ logStartupMilestone: vi.fn() }))
vi.mock('../opencode/opencode-status-plugin-startup-refresh', () => ({
  refreshInstalledOpenCodeStatusPlugins: vi.fn()
}))
vi.mock('../orcad/orcad-artifact-cache-retention', () => ({
  pruneDesktopOrcadArtifactCache: vi.fn()
}))

import { initializeReadyRuntimeServices } from './main-process-ready-runtime'

const TAB = 'tab-1'
const KEPT = '11111111-1111-4111-8111-111111111111'
const DUPLICATE = '22222222-2222-4222-8222-222222222222'
const directories: string[] = []
const stores: Store[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.freezeWritesAsync()
  }
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

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

it('finishes the duplicate-terminal repair before ready services resolve, even behind a held write', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-duplicate-pty-repair-'))
  directories.push(directory)
  fixture.userData = directory
  const inner = new ProfileStateSqliteAuthority(join(directory, 'profile-state.db'), 'topology')
  inner.writeSerializedState(Buffer.from(duplicatePtyProfile()))
  const authority = new DelayedAuthority(inner)
  const store = new Store({
    dataFile: join(directory, 'orca-data.json'),
    profileStateAuthority: authority
  })
  stores.push(store)
  await store.flushPendingOrThrowAsync()
  fixture.state.store = store
  vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})

  // An earlier profile write is still in flight; the repair queues behind it.
  const held = authority.pause()
  store.updateSettings({ agentStatusHooksEnabled: false })
  const heldWrite = store.flushPendingOrThrowAsync()
  await held.started.promise
  let atReady: { memory: string[]; disk: string[] } | null = null
  const ready = initializeReadyRuntimeServices().then(() => {
    atReady = {
      memory: leafIds(store.getWorkspaceSession().terminalLayoutsByTabId[TAB]?.root),
      disk: storedLeafIds(directory)
    }
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  held.finish.resolve()
  await heldWrite
  await ready

  expect(atReady).toEqual({ memory: [KEPT], disk: [KEPT] })
})
