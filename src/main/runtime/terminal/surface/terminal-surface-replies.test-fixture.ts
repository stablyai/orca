// Normalize one desktop scenario's CLI, paired and orcad replies for byte-identical comparison across layout ownership modes.
import { readFileSync } from 'node:fs'
import { vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../../orca-runtime-test-fixtures.spec'
import type { RuntimeSyncWindowGraph, RuntimeTerminalShow } from '../../../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { LayoutCommand } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import { applyCommandToSession } from '../../../persistence/terminal-topology/terminal-pane-admission'
import { partialRuntimeStore } from '../../runtime-store-partial-fixture'

export const SURFACE_TAB_ID = '44444444-4444-4444-8444-444444444444'
export const SURFACE_PTYS = { [HEADLESS_LEAF_ID]: 'pty-a', [HEADLESS_SECOND_LEAF_ID]: 'pty-b' }

type Runtime = InstanceType<typeof OrcaRuntimeService>

/** A saved tab split in two, each pane bound to a live terminal. */
export function surfaceRuntime(
  opts: {
    /** The terminals the host's process inventory lists; every scenario terminal by default. */
    hostLists?: () => readonly string[]
  } = {}
): {
  runtime: Runtime
  store: ReturnType<typeof makeRuntimeStoreWithWorkspaceSession>
  /** Every terminal the runtime asked the PTY host to stop. */
  killed: string[]
  /** Writes the session the way the Store does: then tells its write listeners. */
  setSession: (next: WorkspaceSessionState) => void
  /** A spawn's binding write, as the PTY host commits it through the Store. */
  bindPane: (pane: {
    worktreeId: string
    tabId: string
    leafId: string
    ptyId: string
  }) => Promise<boolean>
} {
  const layout = makeHeadlessTerminalLayout(SURFACE_PTYS)
  const harness = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      activeTabId: SURFACE_TAB_ID,
      activeTabIdByWorktree: { [TEST_WORKTREE_ID]: SURFACE_TAB_ID },
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: SURFACE_TAB_ID,
            ptyId: 'pty-a',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Persisted Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: { [SURFACE_TAB_ID]: layout }
    })
  )
  // The Store's write notice, which main's terminal list follows.
  const written = new Set<(hostId: ExecutionHostId | null) => void>()
  const setSession = (next: WorkspaceSessionState): void => {
    harness.setSession(next)
    for (const listener of written) {
      listener('local')
    }
  }
  const runtimeStore = {
    ...harness.runtimeStore,
    // The runtime's own session write, as the Store applies it: then tells its write listeners.
    setWorkspaceSession: vi.fn((next: WorkspaceSessionState) => setSession(next)),
    getWorkspaceSessionHostIds: (): ExecutionHostId[] => ['local'],
    // A terminal's binding write, as the Store applies it: then tells its write listeners.
    persistPtyBinding: async (
      ...args: Parameters<typeof harness.runtimeStore.persistPtyBinding>
    ): Promise<boolean> => {
      const persisted = await harness.runtimeStore.persistPtyBinding(...args)
      for (const listener of written) {
        listener('local')
      }
      return persisted
    },
    onWorkspaceSessionWritten: (listener: (hostId: ExecutionHostId | null) => void) => {
      written.add(listener)
      return () => written.delete(listener)
    },
    // Main's own layout change, as the Store applies it.
    applyLayoutCommand: async (command: LayoutCommand, hostIds: readonly ExecutionHostId[]) => {
      const change = applyCommandToSession(hostIds[0]!, harness.getSession(), command)
      if (change.session) {
        setSession(change.session)
      }
      return change.value
    }
  }
  const runtime = new OrcaRuntimeService(partialRuntimeStore(runtimeStore))
  const killed: string[] = []
  runtime.setPtyController({
    write: () => true,
    kill: (ptyId: string) => {
      killed.push(ptyId)
      return true
    },
    getForegroundProcess: async () => null,
    listProcesses: vi.fn(async () =>
      (opts.hostLists?.() ?? Object.values(SURFACE_PTYS)).map((id) => ({
        id,
        cwd: TEST_WORKTREE_PATH,
        title: 'sh'
      }))
    )
  })
  for (const ptyId of Object.values(SURFACE_PTYS)) {
    runtime.registerPty(ptyId, TEST_WORKTREE_ID)
  }
  return {
    runtime,
    killed,
    store: harness,
    bindPane: (pane) => runtimeStore.persistPtyBinding(pane),
    setSession
  }
}

/** Today's window graph for the scenario: both panes mounted. */
export function mountedSurfaceGraph(): RuntimeSyncWindowGraph {
  const layout = makeHeadlessTerminalLayout(SURFACE_PTYS)
  return {
    tabs: [
      {
        tabId: SURFACE_TAB_ID,
        worktreeId: TEST_WORKTREE_ID,
        title: 'Persisted Terminal',
        activeLeafId: HEADLESS_LEAF_ID,
        layout: layout.root
      }
    ],
    leaves: Object.entries(SURFACE_PTYS).map(([leafId, ptyId], index) => ({
      tabId: SURFACE_TAB_ID,
      worktreeId: TEST_WORKTREE_ID,
      leafId,
      paneRuntimeId: index + 1,
      ptyId,
      paneTitle: null,
      title: 'Persisted Terminal'
    }))
  }
}

/** Handles are minted at random; each is replaced by its first-seen position. */
function normaliseHandles(value: unknown, ignored: readonly string[]): unknown {
  const names = new Map<string, string>()
  return JSON.parse(JSON.stringify(value), (key, field) => {
    if (ignored.includes(key)) {
      return undefined
    }
    if ((key === 'handle' || key === 'terminal') && typeof field === 'string') {
      const name = names.get(field) ?? `handle-${names.size + 1}`
      names.set(field, name)
      return name
    }
    return field
  })
}

/** Capture every reply, omitting newer fields only when modeling readers that skip them; compare all older wire fields byte for byte. */
export async function captureSurfaceReplies(
  runtime: Runtime,
  opts: { ignore?: readonly string[] } = {}
): Promise<string> {
  const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)
  const shown: RuntimeTerminalShow[] = []
  for (const terminal of listed.terminals) {
    shown.push(await runtime.showTerminal(terminal.handle))
  }
  const status = runtime.getStatus()
  return JSON.stringify(
    normaliseHandles(
      {
        list: listed,
        show: shown,
        status: {
          graphStatus: status.graphStatus,
          liveTabCount: status.liveTabCount,
          liveLeafCount: status.liveLeafCount
        }
      },
      opts.ignore ?? []
    )
  )
}

/** A recorded reply, in the exact bytes JSON.stringify gives the wire (the file is formatted). */
export function recordedSurfaceReplies(file: string): string {
  return JSON.stringify(JSON.parse(readFileSync(file, 'utf8')))
}
