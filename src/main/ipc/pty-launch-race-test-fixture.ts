import { vi, type Mock } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { WORKTREE_TERMINALS_SLEEPING_ERROR } from '../runtime/worktree-terminals-sleeping-error'
import { registerPtyHandlers, setLocalPtyProvider } from './pty'

type IpcHandlerMap = Map<string, (_event: unknown, args: unknown) => unknown>
type LaunchRaceSpawnReply = {
  id: string
  incarnationId?: string
  isReattach?: boolean
  stablePaneOwner?: { handle: string; tabId: string; leafId: string }
}
type LaunchRaceController = {
  spawn(args: Record<string, unknown>): Promise<LaunchRaceSpawnReply>
  claimStablePaneCreate(args: {
    worktreeId: string
    connectionId: string | null
    tabId: string
    leafId: string
  }): () => void
  adoptStablePane(args: Record<string, unknown>): Promise<unknown>
}
type ProviderSpawn = (options: Record<string, unknown>) => Promise<Record<string, unknown>>
export type LaunchRaceProvider = {
  spawn: Mock<ProviderSpawn>
  shutdown: Mock<(...args: unknown[]) => Promise<void>>
}
type LaunchRaceRuntimeBase = Record<
  | 'setPtyController'
  | 'resolveTerminalPane'
  | 'createPreAllocatedTerminalHandle'
  | 'preAllocateHandleForPty'
  | 'registerPreAllocatedHandleForPty'
  | 'beginPtyRegistration'
  | 'cancelPendingPtyRegistration'
  | 'assertPtyRegistrationAllowed'
  | 'registerPty'
  | 'noteTerminalSpawnCommand'
  | 'noteTerminalSpawnCommit'
  | 'reflowHeadlessTerminalToPtyGrid'
  | 'seedHeadlessTerminal'
  | 'onPtySpawned'
  | 'onPtyExit'
  | 'onPtyData',
  Mock
>

/** The two spawn lanes: the window's `pty:spawn` IPC and the host's runtime controller. */
export type LaunchRaceLane = 'ipc' | 'runtime'
export const LAUNCH_RACE_LANES: LaunchRaceLane[] = ['ipc', 'runtime']

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test doubles implement only the members the two spawn lanes read.
const testDouble = <T>(value: unknown): T => value as T

export const flushMacrotasks = async (rounds = 20): Promise<void> => {
  for (let index = 0; index < rounds; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/** One stable pane per test; reservation maps are module state, so names must not repeat. */
export function launchRacePane(tag: string, leafId: string) {
  const worktreeId = `repo-1::/tmp/${tag}`
  const tabId = `tab-${tag}`
  const paneKey = makePaneKey(tabId, leafId)
  return {
    worktreeId,
    tabId,
    leafId,
    args: {
      cols: 80,
      rows: 24,
      cwd: `/tmp/${tag}`,
      worktreeId,
      tabId,
      leafId,
      env: { ORCA_PANE_KEY: paneKey, ORCA_TAB_ID: tabId, ORCA_WORKTREE_ID: worktreeId }
    }
  }
}

/** A non-local provider, so both lanes treat the spawn as daemon-hosted. */
export function installLaunchRaceProvider(spawn: ProviderSpawn): LaunchRaceProvider {
  const provider = {
    spawn: vi.fn(spawn),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    shutdown: vi.fn(async (..._args: unknown[]) => {}),
    sendSignal: vi.fn(),
    getCwd: vi.fn(),
    getInitialCwd: vi.fn(),
    clearBuffer: vi.fn(),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(),
    getForegroundProcess: vi.fn(),
    serialize: vi.fn(),
    revive: vi.fn(),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    listProcesses: vi.fn(async () => []),
    attach: vi.fn(),
    getDefaultShell: vi.fn(),
    getProfiles: vi.fn()
  }
  setLocalPtyProvider(testDouble(provider))
  return provider
}

export function createLaunchRaceRuntime<T extends object = Record<never, never>>(
  overrides?: T
): LaunchRaceRuntimeBase & T {
  const base: LaunchRaceRuntimeBase = {
    setPtyController: vi.fn(),
    resolveTerminalPane: vi.fn((): unknown => {
      throw new Error('terminal_not_found')
    }),
    createPreAllocatedTerminalHandle: vi.fn(() => 'term-launch-race'),
    preAllocateHandleForPty: vi.fn(() => 'term-launch-race'),
    registerPreAllocatedHandleForPty: vi.fn(),
    beginPtyRegistration: vi.fn(),
    cancelPendingPtyRegistration: vi.fn(),
    assertPtyRegistrationAllowed: vi.fn(),
    registerPty: vi.fn(),
    noteTerminalSpawnCommand: vi.fn(),
    noteTerminalSpawnCommit: vi.fn(),
    reflowHeadlessTerminalToPtyGrid: vi.fn(),
    seedHeadlessTerminal: vi.fn(),
    onPtySpawned: vi.fn(),
    onPtyExit: vi.fn(),
    onPtyData: vi.fn()
  }
  return Object.assign(base, overrides)
}

/** Registers both lanes against one runtime, as main does. */
export function registerLaunchRaceLanes(args: {
  handlers: IpcHandlerMap
  mainWindow: unknown
  runtime: { setPtyController: Mock }
  prepareClaudeAuth?: () => Promise<unknown>
  store?: unknown
}) {
  registerPtyHandlers(
    testDouble(args.mainWindow),
    testDouble(args.runtime),
    undefined,
    undefined,
    testDouble(args.prepareClaudeAuth),
    testDouble(args.store)
  )
  const controller = testDouble<LaunchRaceController>(
    args.runtime.setPtyController.mock.calls.at(-1)?.[0]
  )
  const spawn: Record<
    LaunchRaceLane,
    (spawnArgs: Record<string, unknown>) => Promise<LaunchRaceSpawnReply>
  > = {
    ipc: (spawnArgs) =>
      testDouble<Promise<LaunchRaceSpawnReply>>(args.handlers.get('pty:spawn')!(null, spawnArgs)),
    runtime: (spawnArgs) => controller.spawn(spawnArgs)
  }
  return { controller, spawn }
}

export function gatedClaudeAuth() {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const prepareClaudeAuth = vi.fn(async () => {
    await gate
    return { configDir: '/tmp/claude', envPatch: {}, provenance: 'managed:test' }
  })
  return { prepareClaudeAuth, release }
}

/** The host's worktree spawn lock for a slept worktree: refuses only the spawns that ask it to. */
export function sleptWorktreeLock() {
  let refuse!: () => void
  const refusal = new Promise<void>((resolve) => {
    refuse = resolve
  })
  const acquireWorktreeTerminalSpawn = vi.fn(
    async (_worktreeId?: string, opts?: { refuseSleptWorktree?: boolean }) => {
      if (opts?.refuseSleptWorktree) {
        await refusal
        throw new Error(WORKTREE_TERMINALS_SLEEPING_ERROR)
      }
      return () => {}
    }
  )
  return { acquireWorktreeTerminalSpawn, refuse }
}
