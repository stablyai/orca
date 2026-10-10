import { vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  makePaneSpawnReservationKey,
  paneSpawnReservationsByOwnerKey
} from './pty/pane/spawn-reservation'
import { registerPtyHandlers, setLocalPtyProvider } from './pty'

type IpcHandlerMap = Map<string, (_event: unknown, args: unknown) => unknown>
type LaunchRaceSpawnReply = {
  id: string
  incarnationId?: string
  isReattach?: boolean
  stablePaneOwner?: { handle: string; tabId: string; leafId: string }
}
export type LaunchRaceController = {
  spawn(args: Record<string, unknown>): Promise<LaunchRaceSpawnReply>
  claimStablePaneCreate(args: {
    worktreeId: string
    connectionId: string | null
    tabId: string
    leafId: string
  }): () => void
}
type ProviderSpawn = (options: Record<string, unknown>) => Promise<Record<string, unknown>>

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test doubles implement only the members the two spawn lanes read.
const testDouble = <T>(value: unknown): T => value as T

/** One stable pane per test; reservation maps are module state, so names must not repeat. */
export function launchRacePane(tag: string, leafId: string) {
  const worktreeId = `repo-1::/tmp/${tag}`
  const tabId = `tab-${tag}`
  const paneKey = makePaneKey(tabId, leafId)
  return {
    worktreeId,
    tabId,
    leafId,
    paneKey,
    ownerKey: makePaneSpawnReservationKey(worktreeId, null, paneKey)!,
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
export function installLaunchRaceProvider(spawn: ProviderSpawn) {
  const provider = {
    spawn: vi.fn(spawn),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    shutdown: vi.fn(async () => {}),
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

export function createLaunchRaceRuntime<T extends object = Record<never, never>>(overrides?: T) {
  const base = {
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
    seedHeadlessTerminal: vi.fn(),
    onPtySpawned: vi.fn(),
    onPtyExit: vi.fn(),
    onPtyData: vi.fn()
  }
  return { ...base, ...overrides }
}

/** Registers both lanes against one runtime: `pty:spawn` (IPC lane) and the runtime controller. */
export function registerLaunchRaceLanes(args: {
  handlers: IpcHandlerMap
  mainWindow: unknown
  runtime: { setPtyController: ReturnType<typeof vi.fn> }
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
  return {
    controller,
    spawnThroughIpc: (spawnArgs: Record<string, unknown>) =>
      testDouble<Promise<LaunchRaceSpawnReply>>(args.handlers.get('pty:spawn')!(null, spawnArgs))
  }
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

/** Flags the first read of a held reservation's promise, i.e. the moment another spawn joins it. */
export function watchPaneSpawnJoin(ownerKey: string): () => boolean {
  const reservation = paneSpawnReservationsByOwnerKey.get(ownerKey)
  if (!reservation) {
    throw new Error(`no reservation held for ${ownerKey}`)
  }
  const promise = reservation.promise
  let joined = false
  Object.defineProperty(reservation, 'promise', {
    configurable: true,
    get: () => {
      joined = true
      return promise
    }
  })
  return () => joined
}
