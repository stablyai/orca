import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../shared/worktree/id'
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

  it('keeps the first resolved worktree when normalized identities collide', async () => {
    const firstId = `${ROOT_ID}/duplicate/`
    const equivalentId = `${ROOT_ID}/duplicate`
    const laterId = `${ROOT_ID}/later`
    const internals = createRuntimeInternals({
      sessions: [
        { id: 'later-owner-pty', worktreeId: laterId, cwd: FOLDER_PATH, title: 'shell' },
        { id: 'duplicate-owner-pty', worktreeId: equivalentId, cwd: FOLDER_PATH, title: 'shell' }
      ]
    })
    const resolvedWorktrees = [firstId, equivalentId, laterId].map((id) =>
      internals.buildResolvedWorktreeFromId(id)
    )

    await internals.refreshPtyWorktreeRecordsWithControllerInventory(resolvedWorktrees)

    expect(internals.ptysById.get('duplicate-owner-pty')?.worktreeId).toBe(firstId)
  })

  it('stops indexing after a sparse owner match', async () => {
    const ownerId = `${ROOT_ID}/first`
    const internals = createRuntimeInternals({
      sessions: [{ id: 'sparse-owner-pty', worktreeId: ownerId, cwd: FOLDER_PATH, title: 'shell' }]
    })
    let identityReads = 0
    const resolvedWorktrees = [ownerId, `${ROOT_ID}/unused-a`, `${ROOT_ID}/unused-b`].map((id) => {
      const worktree = internals.buildResolvedWorktreeFromId(id)
      if (!worktree || typeof worktree !== 'object') {
        throw new Error(`Failed to resolve ${id}`)
      }
      return Object.defineProperty(worktree, 'id', {
        configurable: true,
        enumerable: true,
        get: () => {
          identityReads += 1
          return id
        }
      })
    })

    await internals.refreshPtyWorktreeRecordsWithControllerInventory(resolvedWorktrees)

    expect(internals.ptysById.get('sparse-owner-pty')?.worktreeId).toBe(ownerId)
    expect(identityReads).toBe(2)
  })

  it('keeps parsed and raw identity domains distinct', async () => {
    const parsedId = `${ROOT_ID}/collision`
    const rawId = `${REPO_ID}\0${FOLDER_PATH}/collision`
    const internals = createRuntimeInternals({
      sessions: [{ id: 'raw-owner-pty', worktreeId: rawId, cwd: FOLDER_PATH, title: 'shell' }]
    })
    const parsedWorktree = internals.buildResolvedWorktreeFromId(parsedId)
    if (!parsedWorktree || typeof parsedWorktree !== 'object') {
      throw new Error(`Failed to resolve ${parsedId}`)
    }
    const rawWorktree = { ...parsedWorktree, id: rawId }

    await internals.refreshPtyWorktreeRecordsWithControllerInventory([parsedWorktree, rawWorktree])

    expect(internals.ptysById.get('raw-owner-pty')?.worktreeId).toBe(rawId)
  })

  it('bounds provider and persisted worktree resolution to linear identity reads', async () => {
    const worktreeCount = 128
    const worktreeIds = Array.from(
      { length: worktreeCount },
      (_, index) => `${ROOT_ID}/worktree-${index}`
    )
    const persistedSession: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: Object.fromEntries(
        worktreeIds.map((worktreeId, index) => [
          worktreeId,
          [
            {
              id: `indexed-tab-${index}`,
              ptyId: `indexed-pty-${index}`,
              worktreeId,
              title: 'shell'
            }
          ]
        ])
      ) as never
    }
    const internals = createRuntimeInternals({
      session: persistedSession,
      sessions: worktreeIds.map((worktreeId, index) => ({
        id: `indexed-pty-${index}`,
        worktreeId,
        cwd: `${FOLDER_PATH}/worktree-${index}`,
        title: 'shell'
      }))
    })
    let identityReads = 0
    const resolvedWorktrees = worktreeIds.map((id) => {
      const worktree = internals.buildResolvedWorktreeFromId(id)
      if (!worktree || typeof worktree !== 'object') {
        throw new Error(`Failed to resolve ${id}`)
      }
      return Object.defineProperty(worktree, 'id', {
        configurable: true,
        enumerable: true,
        get: () => {
          identityReads += 1
          return id
        }
      })
    })

    await internals.refreshPtyWorktreeRecordsWithControllerInventory(resolvedWorktrees)

    expect(internals.ptysById.size).toBe(worktreeCount)
    expect(internals.ptysById.get('indexed-pty-0')?.worktreeId).toBe(worktreeIds[0])
    expect(internals.ptysById.get(`indexed-pty-${worktreeCount - 1}`)?.worktreeId).toBe(
      worktreeIds[worktreeCount - 1]
    )
    expect(identityReads).toBe(worktreeCount * 2)
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
    const internals = createRuntimeInternals({ processLists: [[], []] })
    const releaseA = await internals.acquireWorktreeTerminalSpawn(WORKSPACE_A)

    const spawnB = internals.acquireWorktreeTerminalSpawn(WORKSPACE_B)
    expect(await raceAgainstMicrotaskDrain(spawnB)).toBe('acquired')

    // Control: spawns intentionally share the per-worktree lock (only sleep
    // excludes), so a second A spawn can no longer prove the lock blocks.
    // A's own sleep still must, which keeps 'acquired' above from being a
    // free pass on a lock that never blocks anything.
    const sleepA = internals.sleepTerminalsForWorktree(`id:${WORKSPACE_A}`)
    expect(await raceAgainstMicrotaskDrain(sleepA)).toBe('blocked')

    releaseA()
    ;(await spawnB)()
    await sleepA
  })

  it('grants concurrent spawns for one instance while still excluding its sleep', async () => {
    const internals = createRuntimeInternals({ processLists: [[], []] })
    const releaseFirst = await internals.acquireWorktreeTerminalSpawn(WORKSPACE_A)
    // Why: a multi-tab worktree activates every tab at once; queueing them
    // behind each other was the activation latency staircase.
    const second = internals.acquireWorktreeTerminalSpawn(WORKSPACE_A)
    expect(await raceAgainstMicrotaskDrain(second)).toBe('acquired')

    const sleepA = internals.sleepTerminalsForWorktree(`id:${WORKSPACE_A}`)
    expect(await raceAgainstMicrotaskDrain(sleepA)).toBe('blocked')

    releaseFirst()
    ;(await second)()
    await sleepA
  })
})
