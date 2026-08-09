import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/types'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree-id'
import { OrcaRuntimeService } from './orca-runtime'

// Folder projects back several workspaces with ONE directory; only the
// `::workspace:<uuid>` suffix separates them, so runtime PTY identity must keep it.
const REPO_ID = 'repo-1'
const FOLDER_PATH = '/tmp/folder-project'
const ROOT_ID = `${REPO_ID}::${FOLDER_PATH}`
const WORKSPACE_A = `${ROOT_ID}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
const WORKSPACE_B = `${ROOT_ID}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`
const PTY_A = `${WORKSPACE_A}@@pty-a`
const PTY_B = `${WORKSPACE_B}@@pty-b`
const LEAF_B = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const REPO = {
  id: REPO_ID,
  path: FOLDER_PATH,
  displayName: 'folder-project',
  badgeColor: 'blue',
  addedAt: 1,
  kind: 'folder'
} as const

type RuntimeInternals = {
  buildResolvedWorktreeFromId: (worktreeId: string) => unknown
  refreshPtyWorktreeRecordsWithControllerInventory: (
    resolvedWorktrees: unknown[],
    targetWorktreeId?: string | null
  ) => Promise<{ livePtyIds: Set<string> } | null>
  getLivePtyIdsForWorktree: (worktreeId: string) => Set<string>
  hasExactPersistedTerminalSurfaceIdentity: (expected: {
    worktreeId: string
    tabId: string
    leafId: string
    ptyId: string
    incarnationId: string
  }) => boolean
  ptysById: Map<string, { worktreeId: string }>
  recordPtyWorktree: (ptyId: string, worktreeId: string, state?: Record<string, unknown>) => unknown
  onClientEvent: (listener: (event: RuntimeClientEvent) => void) => () => void
  onPtyExit: (ptyId: string, exitCode: number) => void
  sleepTerminalsForWorktree: (worktreeSelector: string) => Promise<unknown>
  acquireWorktreeTerminalSpawn: (worktreeId?: string) => Promise<() => void>
  getTerminalSleepClientEventSnapshot: () => RuntimeClientEvent[]
}

const OWNED_CONTROLLER_SESSIONS = [
  { id: PTY_A, worktreeId: WORKSPACE_A, cwd: FOLDER_PATH, title: 'a' },
  { id: PTY_B, worktreeId: WORKSPACE_B, cwd: FOLDER_PATH, title: 'b' }
]

function createRuntimeInternals(
  options: {
    session?: WorkspaceSessionState
    sessions?: unknown[]
    // Consecutive controller inventories, so a sleep sees its PTY then sees it gone.
    processLists?: unknown[][]
  } = {}
): RuntimeInternals {
  const meta: Record<string, Record<string, unknown>> = {
    [WORKSPACE_A]: { hostId: 'local' },
    [WORKSPACE_B]: { hostId: 'local' }
  }
  const store = {
    getRepos: () => [REPO],
    getRepo: (id: string) => (id === REPO_ID ? REPO : undefined),
    getAllWorktreeMeta: () => meta,
    getWorktreeMeta: (worktreeId: string) => meta[worktreeId],
    setWorktreeMeta: (worktreeId: string, patch: Record<string, unknown>) => {
      meta[worktreeId] = { ...meta[worktreeId], ...patch }
      return meta[worktreeId]
    },
    getWorkspaceSession: () => options.session ?? getDefaultWorkspaceSession(),
    setWorkspaceSession: () => {},
    flushOrThrow: () => {}
  } as never
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    stopAndWait: async (ptyId: string) => {
      runtime.onPtyExit(ptyId, -1)
      return true
    },
    getForegroundProcess: async () => null,
    listProcesses: async () =>
      options.processLists
        ? (options.processLists.shift() ?? [])
        : (options.sessions ?? OWNED_CONTROLLER_SESSIONS)
  } as never)
  return runtime as unknown as RuntimeInternals
}

/**
 * Resolves to 'blocked' only if `pending` has not settled once the microtask queue drains —
 * an uncontended mutation lease is pure-promise, so this never waits on wall-clock time.
 */
async function raceAgainstMicrotaskDrain(pending: Promise<unknown>): Promise<string> {
  return await Promise.race([
    pending.then(() => 'acquired'),
    new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 0))
  ])
}

describe('folder workspaces sharing one directory', () => {
  it('keeps each workspace instance bound to its own controller PTY', async () => {
    const internals = createRuntimeInternals()
    const resolvedWorktrees = [WORKSPACE_A, WORKSPACE_B].map((id) =>
      internals.buildResolvedWorktreeFromId(id)
    )

    await internals.refreshPtyWorktreeRecordsWithControllerInventory(resolvedWorktrees)

    expect(internals.ptysById.get(PTY_A)?.worktreeId).toBe(WORKSPACE_A)
    expect(internals.ptysById.get(PTY_B)?.worktreeId).toBe(WORKSPACE_B)
  })

  it('selects only the targeted workspace instance from a controller inventory', async () => {
    const internals = createRuntimeInternals()
    const resolvedWorktrees = [WORKSPACE_A, WORKSPACE_B].map((id) =>
      internals.buildResolvedWorktreeFromId(id)
    )

    const inventory = await internals.refreshPtyWorktreeRecordsWithControllerInventory(
      resolvedWorktrees,
      WORKSPACE_B
    )

    expect([...(inventory?.livePtyIds ?? [])]).toEqual([PTY_B])
  })

  it('reports live PTYs per workspace instance and for the folder root separately', () => {
    const internals = createRuntimeInternals()
    internals.recordPtyWorktree(PTY_A, WORKSPACE_A, { connected: true })
    internals.recordPtyWorktree(PTY_B, WORKSPACE_B, { connected: true })
    internals.recordPtyWorktree('pty-root', ROOT_ID, { connected: true })

    expect([...internals.getLivePtyIdsForWorktree(WORKSPACE_A)]).toEqual([PTY_A])
    expect([...internals.getLivePtyIdsForWorktree(WORKSPACE_B)]).toEqual([PTY_B])
    expect([...internals.getLivePtyIdsForWorktree(ROOT_ID)]).toEqual(['pty-root'])
  })

  it('resolves a persisted terminal surface while a sibling instance also has tabs', () => {
    const paneKey = makePaneKey('tab-b', LEAF_B)
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [WORKSPACE_A]: [{ id: 'tab-a', worktreeId: WORKSPACE_A, title: 'A' }],
        [WORKSPACE_B]: [{ id: 'tab-b', worktreeId: WORKSPACE_B, title: 'B' }]
      } as never,
      terminalLayoutsByTabId: {
        'tab-b': { root: null, activeLeafId: LEAF_B, ptyIdsByLeafId: { [LEAF_B]: PTY_B } }
      } as never,
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-b' }
    }
    const internals = createRuntimeInternals({ session })

    expect(
      internals.hasExactPersistedTerminalSurfaceIdentity({
        worktreeId: WORKSPACE_B,
        tabId: 'tab-b',
        leafId: LEAF_B,
        ptyId: PTY_B,
        incarnationId: 'inc-b'
      })
    ).toBe(true)
  })

  it('attributes an unowned cwd-only PTY to the targeted instance, not a sibling', async () => {
    const internals = createRuntimeInternals({
      sessions: [{ id: 'legacy-cwd-pty', cwd: `${FOLDER_PATH}/src`, title: 'legacy' }]
    })
    const resolvedWorktrees = [WORKSPACE_A, WORKSPACE_B].map((id) =>
      internals.buildResolvedWorktreeFromId(id)
    )

    const inventory = await internals.refreshPtyWorktreeRecordsWithControllerInventory(
      resolvedWorktrees,
      WORKSPACE_B
    )

    expect([...(inventory?.livePtyIds ?? [])]).toEqual(['legacy-cwd-pty'])
    expect(internals.ptysById.get('legacy-cwd-pty')?.worktreeId).toBe(WORKSPACE_B)
  })

  it('leaves a sleeping instance asleep when a sibling instance spawns a terminal', async () => {
    const internals = createRuntimeInternals({
      processLists: [[{ id: PTY_A, worktreeId: WORKSPACE_A, cwd: FOLDER_PATH, title: 'a' }], []]
    })
    const events: RuntimeClientEvent[] = []
    internals.onClientEvent((event) => events.push(event))

    await internals.sleepTerminalsForWorktree(`id:${WORKSPACE_A}`)
    const release = await internals.acquireWorktreeTerminalSpawn(WORKSPACE_B)
    release()

    // A shared identity key would wake A's stopped terminals on B's spawn and tell clients so.
    expect(
      events.filter(
        (event) => event.type === 'worktreeTerminalSleepState' && event.phase === 'woken'
      )
    ).toEqual([])
    expect(internals.getTerminalSleepClientEventSnapshot()).toEqual([
      expect.objectContaining({ worktreeId: WORKSPACE_A, phase: 'committed', ptyIds: [PTY_A] })
    ])
  })

  it('does not serialize a sibling instance behind this instance held terminal mutation', async () => {
    const internals = createRuntimeInternals()
    const releaseA = await internals.acquireWorktreeTerminalSpawn(WORKSPACE_A)

    const spawnB = internals.acquireWorktreeTerminalSpawn(WORKSPACE_B)
    const spawnSecondA = internals.acquireWorktreeTerminalSpawn(WORKSPACE_A)

    expect(await raceAgainstMicrotaskDrain(spawnB)).toBe('acquired')
    // Control: same-instance mutations must still queue, so 'acquired' above is not a free pass.
    expect(await raceAgainstMicrotaskDrain(spawnSecondA)).toBe('blocked')

    releaseA()
    ;(await spawnB)()
    ;(await spawnSecondA)()
  })
})
