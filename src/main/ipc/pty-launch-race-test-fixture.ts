import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { PersistPtyBindingArgs } from '../persistence/loading-store/pty-binding-persistence'
import { ptyBindingIsRefused } from '../persistence/loading-store/pty-binding-refusals'
import { applyPtyBinding } from '../persistence/loading-store/pty-binding-session-update'
import {
  withRuntimePaneAdmission,
  withDurableRuntimeStore
} from '../runtime/runtime-durable-store-fixture'
import { vi, type Mock } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { WORKTREE_TERMINALS_SLEEPING_ERROR } from '../runtime/worktree-terminals-sleeping-error'
import { registerPtyHandlers } from './pty/register-handlers'

type IpcHandlerMap = Map<string, (_event: unknown, args: unknown) => unknown>
type LaunchRaceSpawnReply = {
  id: string
  incarnationId?: string
  isReattach?: boolean
}
type LaunchRaceController = {
  spawn(args: Record<string, unknown>): Promise<LaunchRaceSpawnReply>
  claimStablePaneCreate(args: {
    worktreeId: string
    connectionId: string | null
    tabId: string
    leafId: string
  }): () => void
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

export type LaunchRaceLane = 'ipc' | 'runtime'
export const LAUNCH_RACE_LANES: LaunchRaceLane[] = ['ipc', 'runtime']

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

export function createLaunchRaceRuntime<T extends object = Record<never, never>>(
  overrides?: T
): LaunchRaceRuntimeBase & T {
  let owner:
    | {
        ptyId: string
        worktreeId: string
        tabId: string
        leafId: string
        handle: string
      }
    | undefined
  const base: LaunchRaceRuntimeBase = {
    setPtyController: vi.fn(),
    resolveTerminalPane: vi.fn((): unknown => {
      if (owner) {
        return owner
      }
      throw new Error('terminal_not_found')
    }),
    createPreAllocatedTerminalHandle: vi.fn(() => 'term-launch-race'),
    preAllocateHandleForPty: vi.fn(() => 'term-launch-race'),
    registerPreAllocatedHandleForPty: vi.fn(),
    beginPtyRegistration: vi.fn(),
    cancelPendingPtyRegistration: vi.fn(),
    assertPtyRegistrationAllowed: vi.fn(),
    registerPty: vi.fn(
      (
        ptyId: string,
        worktreeId: string,
        _connection: unknown,
        binding: { tabId: string; leafId: string }
      ) => {
        owner = { ptyId, worktreeId, ...binding, handle: 'term-launch-race' }
      }
    ),
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

export function sleptWorktreeLock() {
  let refuse!: () => void
  const refusal = new Promise<void>((resolve) => {
    refuse = resolve
  })
  const acquireWorktreeTerminalSpawn = vi.fn(
    async (_target?: unknown, opts?: { refuseSleptWorktree?: boolean }) => {
      if (opts?.refuseSleptWorktree) {
        await refusal
        throw new Error(WORKTREE_TERMINALS_SLEEPING_ERROR)
      }
      return () => {}
    }
  )
  return { acquireWorktreeTerminalSpawn, refuse }
}

export function createPaneBindingStore() {
  let session = getDefaultWorkspaceSession()
  const bindingWrites = vi.fn((_binding: PersistPtyBindingArgs) => true)
  const store = withDurableRuntimeStore(
    withRuntimePaneAdmission({
      flushOrThrow: () => {},
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: typeof session) => {
        session = next
      },
      persistPtyBinding: vi.fn(
        async (input: PersistPtyBindingArgs | (() => PersistPtyBindingArgs | null)) => {
          const binding = typeof input === 'function' ? input() : input
          if (!binding) {
            return false
          }
          const accepted = bindingWrites(binding)
          const paneKey = makePaneKey(binding.tabId, binding.leafId)
          const workspace = binding.expectedSourceBinding?.worktreeId ?? binding.worktreeId
          if (!accepted || ptyBindingIsRefused(binding, session, workspace, paneKey, [])) {
            return false
          }
          applyPtyBinding(binding, session, workspace, paneKey)
          return true
        }
      )
    })
  )
  return { ...store, bindingWrites }
}
