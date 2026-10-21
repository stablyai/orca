// The pane-owner swap harness: a real binding store over a fake session, a fake provider, and the
// real IPC spawn pipeline. The caller's test file declares the module mocks (see the restart test).
import { vi, type Mock } from 'vitest'
import { PtyBindingPersistenceOperations } from '../persistence/loading-store/pty-binding-persistence'
import { ptyBindingGenerationOf } from '../persistence/loading-store/pty-binding-generations'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { PtyIpcSuiteFixtures } from './pty-ipc-test-harness'
import { TerminalKilledError } from '../daemon/daemon-pty-lifecycle-errors'
import { SessionNotFoundError } from '../daemon/daemon-errors'
import { makePaneKey } from '../../shared/stable-pane-id'
import { registerPtyHandlers } from './pty/register-handlers'
import { setLocalPtyProvider } from './pty/provider/registry'
import { TerminalIntentionalStops } from '../runtime/terminal-intentional-stops'

/** A named type, so the exported harness's inferred type stays portable. */
function stub(): Mock<(...args: unknown[]) => unknown> {
  return vi.fn()
}

export const worktreeId = 'repo-1::/tmp/restart'
export const cwd = '/tmp/restart'
export const tabId = 'tab-restart'
export const leafId = '12121212-1212-4212-8212-121212121212'
export const paneKey = makePaneKey(tabId, leafId)

export type RestartHarness = ReturnType<typeof installRestartHarness>
type FakeSession = {
  tabsByWorktree: Record<string, { id: string; worktreeId: string; ptyId: string | null }[]>
  terminalLayoutsByTabId: Record<
    string,
    {
      root: { type: 'leaf'; leafId: string }
      activeLeafId: string
      expandedLeafId: null
      ptyIdsByLeafId: Record<string, string>
    }
  >
  terminalPtyIncarnationsByPaneKey: Record<string, string>
}

export function seedSession(ptyId: string): FakeSession {
  return {
    tabsByWorktree: { [worktreeId]: [{ id: tabId, worktreeId, ptyId }] },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: ptyId }
      }
    },
    terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-old' }
  }
}

export function registerWithFakes(
  mainWindow: PtyIpcSuiteFixtures['mainWindow'],
  runtime: RestartHarness['runtime'],
  store: RestartHarness['store']
): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spawn and kill read only the window, runtime and store members these fakes define.
  const args = [
    mainWindow,
    runtime,
    undefined,
    undefined,
    undefined,
    store
  ] as unknown as Parameters<typeof registerPtyHandlers>
  registerPtyHandlers(...args)
}

export function installRestartHarness(
  options: {
    shutdownFails?: boolean
    shutdownGate?: Promise<void>
    /** The owning host answers that the old process is gone, as after a relaunch. */
    oldSessionAbsent?: boolean
    freshId?: string
    /** Null: the fresh process reports no incarnation (a provider without one). */
    freshIncarnationId?: string | null
  } = {}
) {
  let oldSessionAlive = true
  const writeListeners = new Set<(hostId: null) => void>()
  const control = { shutdownFails: options.shutdownFails ?? false, failNextWrite: false }
  const boundAtFreshLaunch: (string | undefined)[] = []
  const providerSpawn = vi.fn(async (spawnOptions: { attachOnly?: boolean }) => {
    if (!spawnOptions.attachOnly) {
      boundAtFreshLaunch.push(leafBinding())
      const incarnationId =
        options.freshIncarnationId === undefined ? 'inc-new' : options.freshIncarnationId
      return { id: options.freshId ?? 'pty-new', ...(incarnationId ? { incarnationId } : {}) }
    }
    if (options.oldSessionAbsent) {
      throw new SessionNotFoundError('pty-old')
    }
    if (!oldSessionAlive) {
      throw new TerminalKilledError('pty-old')
    }
    return { id: 'pty-old', incarnationId: 'inc-old', isReattach: true }
  })
  const shutdown = vi.fn(async () => {
    await options.shutdownGate
    if (control.shutdownFails) {
      throw new Error('daemon unreachable')
    }
    oldSessionAlive = false
  })
  const provider = {
    spawn: providerSpawn,
    write: stub(),
    resize: stub(),
    kill: stub(),
    shutdown,
    sendSignal: stub(),
    getCwd: stub(),
    getInitialCwd: stub(),
    clearBuffer: stub(),
    acknowledgeDataEvent: stub(),
    hasChildProcesses: stub(),
    getForegroundProcess: stub(),
    serialize: stub(),
    revive: stub(),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    listProcesses: vi.fn(async () => []),
    attach: stub(),
    getDefaultShell: stub(),
    getProfiles: stub()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restart path calls only the provider members this fake defines.
  setLocalPtyProvider(provider as unknown as Parameters<typeof setLocalPtyProvider>[0])
  let session = seedSession('pty-old')
  const store = {
    getWorkspaceSession: vi.fn((_hostId?: string): FakeSession => session),
    setWorkspaceSession: vi.fn((next) => {
      session = next
    }),
    flushOrThrow: stub(),
    onWorkspaceSessionWritten: (listener: (hostId: null) => void) => {
      writeListeners.add(listener)
      return () => writeListeners.delete(listener)
    },
    runDurableMutation: vi.fn(
      async <T>(
        mutate: () => { value: T; persist?: boolean | 'if-dirty'; rollback?: () => void }
      ) => {
        const mutation = mutate()
        if (mutation.persist !== false) {
          if (control.failNextWrite) {
            control.failNextWrite = false
            mutation.rollback?.()
            throw new Error('save failed')
          }
          durableBindings.push(leafBinding())
          for (const listener of writeListeners) {
            listener(null)
          }
        }
        return mutation.value
      }
    ),
    getWorkspaceSessionHostIds: vi.fn(() => [
      'local',
      ...Object.keys(state.workspaceSessionsByHostId)
    ]),
    getFolderWorkspace: vi.fn(() => undefined),
    getFolderWorkspaces: vi.fn(() => []),
    getProjectGroups: vi.fn(() => []),
    getRepos: vi.fn(() => [])
  }
  const state: {
    workspaceSession: FakeSession
    workspaceSessionsByHostId: Record<string, FakeSession>
  } = { workspaceSession: session, workspaceSessionsByHostId: {} }
  const durableBindings: (string | undefined)[] = []
  function leafBinding(hostId?: string): string | undefined {
    return store.getWorkspaceSession(hostId).terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
  }
  // Like the store, a missing host partition reads as an empty session, never the local one.
  store.getWorkspaceSession.mockImplementation((hostId?: string) =>
    hostId && hostId !== 'local'
      ? (state.workspaceSessionsByHostId[hostId] ?? {
          tabsByWorktree: {},
          terminalLayoutsByTabId: {},
          terminalPtyIncarnationsByPaneKey: {}
        })
      : state.workspaceSession
  )
  const bindingRuntime = {
    state,
    dirtyProfileStateDomains: new Set(),
    runDurableMutation: store.runDurableMutation,
    writeTimer: null,
    pendingWrite: null,
    quitFlushStarted: false,
    writeGeneration: 0,
    lastDurableWriteGeneration: 0,
    ptyBindingGenerations: new Map<string, number>()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: binding writes read only state, write bookkeeping, durable mutation and the session partitions from these fakes.
  const bindingArgs = [bindingRuntime, store] as unknown as ConstructorParameters<
    typeof PtyBindingPersistenceOperations
  >
  const bindingOperations = new PtyBindingPersistenceOperations(...bindingArgs)
  const storeWithRetirement = Object.assign(store, {
    persistPtyBinding: vi.fn(bindingOperations.persistPtyBinding.bind(bindingOperations)),
    retirePtyBinding: bindingOperations.retirePtyBinding.bind(bindingOperations),
    getPtyBindingGeneration: (hostId: ExecutionHostId, leafId: string) =>
      ptyBindingGenerationOf(bindingRuntime, hostId, leafId)
  })
  const runtime = {
    setPtyController: stub(),
    resolveTerminalPane: vi.fn(() => {
      throw new Error('terminal_not_found')
    }),
    markPtyStopRequested: stub(),
    createPreAllocatedTerminalHandle: vi.fn(() => 'term-restart'),
    preAllocateHandleForPty: vi.fn(() => 'term-restart'),
    registerPreAllocatedHandleForPty: stub(),
    beginPtyRegistration: stub(),
    cancelPendingPtyRegistration: stub(),
    assertPtyRegistrationAllowed: stub(),
    registerPty: stub(),
    noteTerminalSpawnCommand: stub(),
    seedHeadlessTerminal: stub(),
    onPtySpawned: stub(),
    onPtyExit: stub(),
    onPtyData: stub(),
    intentionalPtyStops: new TerminalIntentionalStops()
  }
  return {
    providerSpawn,
    shutdown,
    store: storeWithRetirement,
    runtime,
    control,
    provider,
    leafBinding,
    durableBindings,
    boundAtFreshLaunch,
    partitions: state.workspaceSessionsByHostId
  }
}

export function restartSpawnArgs(extra: { replacesPtyId?: string } = {}) {
  return {
    cols: 80,
    rows: 24,
    cwd,
    command: 'codex',
    launchAgent: 'codex',
    worktreeId,
    tabId,
    leafId,
    env: { ORCA_PANE_KEY: paneKey, ORCA_TAB_ID: tabId, ORCA_WORKTREE_ID: worktreeId },
    ...extra
  }
}
