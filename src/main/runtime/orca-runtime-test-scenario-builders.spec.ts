import * as mocks from './orca-runtime-test-mocks.spec'
import type { Mock } from 'vitest'

const { HEADLESS_RUNTIME_WINDOW_ID, OrcaRuntimeService, electronMocks } = mocks
const { getBrowserHostLeaseRegistry, getDefaultWorkspaceSession, getRuntimeBrowserPageRegistry } =
  mocks
const { gitRunner, vi } = mocks

import * as fixtures from './orca-runtime-test-fixtures.spec'

const { HEADLESS_LEAF_ID, TEST_REPO_ID, TEST_REPO_PATH, TEST_WINDOW_ID, TEST_WORKTREE_ID } =
  fixtures
const { TEST_WORKTREE_PATH, makeHeadlessTerminalLayout, makeRuntimeStoreWithWorkspaceSession } =
  fixtures
const { makeWorkspaceSessionWithHeadlessTerminal, store } = fixtures

import type {
  BrowserClientHostCommandEvent,
  RuntimeBrowserClientPlacement,
  TerminalSideEffectBatch,
  WorkspaceSessionState
} from './orca-runtime-test-mocks.spec'
import type { OrchestrationDb } from './orchestration/db'

type RuntimeService = InstanceType<typeof OrcaRuntimeService>
type TestMock = Mock

type MobileCreateTestNotifier = {
  focusTerminal: TestMock
  worktreesChanged: TestMock
  reposChanged: TestMock
  activateWorktree: TestMock
  createTerminal: TestMock
  revealTerminalSession: TestMock
  splitTerminal: TestMock
  renameTerminal: TestMock
  closeTerminal: (tabId: string, paneRuntimeId?: number) => void
  closeSessionTab: TestMock
  sleepWorktree: TestMock
  terminalFitOverrideChanged: TestMock
  terminalDriverChanged: TestMock
}

function attachClientBrowserHost(runtime: RuntimeService) {
  const leases = getBrowserHostLeaseRegistry(runtime)
  let commands: BrowserClientHostCommandEvent[] = []
  const { lease } = leases.attach({
    browserHostClientId: 'host-a',
    connectionId: 'connection-a',
    pairedDeviceId: 'device-a',
    hostCapabilities: ['webview'],
    pageCommandProtocolVersion: 1,
    pageInventoryProtocolVersion: 1,
    pageInventory: [],
    pageReconciliationProtocolVersion: 1
  })
  const identity = {
    authorityEpoch: lease.authorityEpoch,
    browserHostClientId: lease.browserHostClientId,
    browserHostGeneration: lease.browserHostGeneration,
    pairedDeviceId: lease.pairedDeviceId
  }
  const detachDelivery = leases.attachCommandDelivery(identity, (event) => commands.push(event))
  return {
    detachDelivery,
    takeCommands(): BrowserClientHostCommandEvent[] {
      const taken = commands
      commands = []
      return taken
    },
    settleLatest(): void {
      const command = commands.at(-1)
      if (!command) {
        throw new Error('no command was delivered to the client host')
      }
      leases.settleClientPageCommand(
        { ...identity, connectionId: lease.connectionId },
        {
          authorityRuntimeId: command.authorityRuntimeId,
          authorityEpoch: command.authorityEpoch,
          browserHostClientId: command.browserHostClientId,
          browserHostGeneration: command.browserHostGeneration,
          pageCommandProtocolVersion: command.pageCommandProtocolVersion,
          ...(command.pageReconciliationProtocolVersion
            ? { pageReconciliationProtocolVersion: command.pageReconciliationProtocolVersion }
            : {}),
          browserPageId: command.browserPageId,
          pageHostGeneration: command.pageHostGeneration,
          commandSequence: command.commandSequence,
          commandId: command.commandId,
          result: { status: 'completed' }
        }
      )
    }
  }
}

async function publishClientHostedPage(
  runtime: RuntimeService,
  host: ReturnType<typeof attachClientBrowserHost>,
  browserPageId: string,
  workspaceId: string
): Promise<RuntimeBrowserClientPlacement> {
  const creation = getBrowserHostLeaseRegistry(runtime).createClientPage({
    browserPageId,
    browserHostClientId: 'host-a',
    pairedDeviceId: 'device-a',
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:7'
  })
  host.settleLatest()
  const placement = await creation
  getRuntimeBrowserPageRegistry(runtime).publishClientPage({
    browserPageId,
    workspaceId,
    browserProfileId: 'profile-a',
    executionHostKey: 'native:runtime-a:7',
    placement,
    url: 'https://remote.internal/',
    loading: false,
    active: true
  })
  host.takeCommands()
  return placement
}

// Why (#10333): `orca serve` publishes a ready graph under
// HEADLESS_RUNTIME_WINDOW_ID with no BrowserWindow behind it, so every
// focus-requested create used to fall through to getAuthoritativeWindow().
const wireHeadlessServeRuntime = (): RuntimeService => {
  const runtime = new OrcaRuntimeService(store)
  electronMocks.BrowserWindow.fromId.mockReturnValue(null as never)
  runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
  return runtime
}

function publishLegacyWorkerReveal(
  runtime: RuntimeService,
  identity: { worktreeId: string; tabId: string; leafId: string; ptyId: string },
  title = 'Recovered legacy worker'
): { tabId: string; identity: typeof identity } {
  runtime.attachWindow(TEST_WINDOW_ID)
  runtime.syncWindowGraph(TEST_WINDOW_ID, {
    tabs: [
      {
        tabId: identity.tabId,
        worktreeId: identity.worktreeId,
        title,
        activeLeafId: identity.leafId,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: identity.tabId,
        worktreeId: identity.worktreeId,
        leafId: identity.leafId,
        paneRuntimeId: 1,
        ptyId: identity.ptyId
      }
    ]
  })
  return { tabId: identity.tabId, identity }
}

function makePostRevealWorkerRecoveryHarness(
  hasPty: (ptyId: string) => boolean | null,
  listProcesses?: () => Promise<
    {
      id: string
      incarnationId: string
      terminalHandle: string
      title: string
      cwd: string
      worktreeId: string
      wslDistro: null
    }[]
  >
): {
  runtime: RuntimeService
  getSession: () => WorkspaceSessionState
  workerPaneKey: string
  ptyId: string
  incarnationId: string
  terminalHandle: string
  kill: ReturnType<typeof vi.fn>
  revealTerminalSession: ReturnType<typeof vi.fn>
  resolveLegacyWorkerTerminalRecovery: ReturnType<typeof vi.fn>
} {
  const workerPaneKey = `legacy-post-reveal:${HEADLESS_LEAF_ID}`
  const ptyId = 'pty-post-reveal'
  const incarnationId = '45454545-4545-4545-8545-454545454545'
  const terminalHandle = 'term_post_reveal'
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [TEST_WORKTREE_ID]: [] },
    sleepingAgentSessionsByPaneKey: {
      [workerPaneKey]: {
        paneKey: workerPaneKey,
        tabId: 'legacy-post-reveal',
        worktreeId: TEST_WORKTREE_ID,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'legacy-post-reveal-session' },
        prompt: 'continue',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'live'
      }
    }
  }
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession(session)
  const runtime = new OrcaRuntimeService(
    { ...runtimeStore, flushOrThrow: vi.fn() } as never,
    undefined,
    { canRecoverPersistentLocalPtys: () => true }
  )
  runtime.setOrchestrationDb({
    getActiveDispatchForTerminal: () => undefined,
    listLegacyWorkerTerminalRecoveryRows: () => [
      {
        dispatch_id: 'dispatch-post-reveal',
        task_id: 'task-post-reveal',
        dispatch_status: 'completed',
        contract_version: 0,
        assignee_handle: 'term_post_reveal',
        assignee_pane_key: workerPaneKey,
        process_incarnation: `${ptyId}:${incarnationId}`,
        worker_state: 'ready',
        worktree_id: TEST_WORKTREE_ID,
        agent_terminal_handle: 'term_post_reveal'
      }
    ]
  } as unknown as OrchestrationDb)
  const kill = vi.fn(() => true)
  runtime.setPtyController({
    write: vi.fn(() => true),
    kill,
    getForegroundProcess: async () => null,
    hasPty,
    listProcesses:
      listProcesses ??
      (async () => [
        {
          id: ptyId,
          incarnationId,
          terminalHandle: 'term_post_reveal',
          title: 'Post-reveal worker',
          cwd: TEST_WORKTREE_PATH,
          worktreeId: TEST_WORKTREE_ID,
          wslDistro: null
        }
      ])
  })
  const revealTerminalSession = vi.fn().mockResolvedValue({
    tabId: 'legacy-post-reveal',
    identity: {
      worktreeId: TEST_WORKTREE_ID,
      tabId: 'legacy-post-reveal',
      leafId: HEADLESS_LEAF_ID,
      ptyId
    }
  })
  const resolveLegacyWorkerTerminalRecovery = vi.fn()
  runtime.setNotifier({
    revealTerminalSession,
    resolveLegacyWorkerTerminalRecovery
  } as never)
  return {
    runtime,
    getSession,
    workerPaneKey,
    ptyId,
    incarnationId,
    terminalHandle,
    kill,
    revealTerminalSession,
    resolveLegacyWorkerTerminalRecovery
  }
}

function makePendingAgentTabActivationRuntime(opts: { disabledTuiAgents?: string[] } = {}): {
  runtime: RuntimeService
  spawn: ReturnType<typeof vi.fn>
} {
  const spawn = vi.fn().mockResolvedValue({ id: 'serve-materialized-pty' })
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId: 'serve-dead-pty',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            launchAgent: 'claude'
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'serve-dead-pty' })
      }
    })
  )
  const runtime = new OrcaRuntimeService({
    ...runtimeStore,
    getSettings: () => ({
      ...store.getSettings(),
      disabledTuiAgents: opts.disabledTuiAgents ?? []
    })
  } as never)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, spawn }
}

// Why: the five #7587 mobile-create tests share one notifier factory so interface changes live in one place.
function createMobileCreateTestNotifier(
  closeTerminal: (tabId: string, paneRuntimeId?: number) => void
): MobileCreateTestNotifier {
  return {
    focusTerminal: vi.fn(),
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    closeTerminal,
    closeSessionTab: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  }
}

function createWorktreeRemovalRuntime(runtimeStore: unknown = store): RuntimeService {
  const emptyPtyProvider = {
    listProcesses: vi.fn(async () => []),
    shutdown: vi.fn(async () => {})
  }
  return new OrcaRuntimeService(runtimeStore as never, undefined, {
    getLocalProvider: () => emptyPtyProvider as never,
    getSshProvider: () => emptyPtyProvider as never
  })
}

const remoteTrackingBase = {
  remote: 'origin',
  branch: 'main',
  ref: 'refs/remotes/origin/main',
  base: 'origin/main'
}

function createReconcileRuntime(): {
  runtime: RuntimeService
  worktreeBaseStatus: ReturnType<typeof vi.fn>
} {
  const worktreeBaseStatus = vi.fn()
  const runtime = new OrcaRuntimeService(store)
  runtime.setNotifier({
    worktreeBaseStatus,
    worktreeRemoteBranchConflict: vi.fn()
  } as never)
  return { runtime, worktreeBaseStatus }
}

function mockReconcileGit(options: {
  postFetchSha?: string
  ancestor?: boolean
  baseRefMissing?: boolean
}) {
  const { postFetchSha = 'new-base-sha', ancestor = true, baseRefMissing = false } = options

  return vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args, options) => {
    const command = args as string[]
    const cwd = (options as { cwd?: string } | undefined)?.cwd
    if (
      cwd === TEST_REPO_PATH &&
      command[0] === 'rev-parse' &&
      command[1] === '--verify' &&
      command[2] === `${remoteTrackingBase.ref}^{commit}`
    ) {
      if (baseRefMissing) {
        throw new Error('missing base ref')
      }
      return { stdout: `${postFetchSha}\n`, stderr: '' }
    }
    if (cwd === TEST_REPO_PATH && command[0] === 'merge-base') {
      if (!ancestor) {
        throw new Error('not ancestor')
      }
      return { stdout: '', stderr: '' }
    }
    if (cwd === TEST_REPO_PATH && command[0] === 'rev-list') {
      return { stdout: '3\n', stderr: '' }
    }
    if (cwd === TEST_REPO_PATH && command[0] === 'log') {
      return { stdout: 'base commit 3\nbase commit 2\n', stderr: '' }
    }
    if (cwd === TEST_REPO_PATH && command[0] === 'config') {
      throw new Error('config missing')
    }
    if (
      cwd === TEST_REPO_PATH &&
      command[0] === 'rev-parse' &&
      command[1] === '--verify' &&
      command[2] === 'refs/remotes/origin/feature^{commit}'
    ) {
      throw new Error('no publish branch conflict')
    }
    throw new Error(`unexpected git command: ${command.join(' ')}`)
  })
}

async function reconcileWithToken(runtime: RuntimeService, token: string): Promise<void> {
  await runtime.reconcileWorktreeBaseStatus({
    repoId: TEST_REPO_ID,
    repoPath: TEST_REPO_PATH,
    worktreeId: TEST_WORKTREE_ID,
    base: remoteTrackingBase,
    branchName: 'feature',
    createdBaseSha: 'created-base-sha',
    token,
    fetchPromise: Promise.resolve({ ok: true })
  })
}
function createSideEffectRuntime(): {
  runtime: RuntimeService
  batches: TerminalSideEffectBatch[]
} {
  const batches: TerminalSideEffectBatch[] = []
  const runtime = new OrcaRuntimeService(store, undefined, {
    onTerminalSideEffects: (batch) => batches.push(batch)
  })
  return { runtime, batches }
}

export { attachClientBrowserHost, createMobileCreateTestNotifier, createReconcileRuntime }
export { createSideEffectRuntime, createWorktreeRemovalRuntime }
export { makePendingAgentTabActivationRuntime, makePostRevealWorkerRecoveryHarness }
export { mockReconcileGit, publishClientHostedPage, publishLegacyWorkerReveal, reconcileWithToken }
export { remoteTrackingBase, wireHeadlessServeRuntime }
