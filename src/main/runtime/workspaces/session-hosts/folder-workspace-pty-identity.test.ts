import { withDurableRuntimeStore } from '../../orca-runtime-tests/runtime-durable-store-fixture'
import { describe, expect, it } from 'vitest'
import {
  spawnWorktreeTarget,
  type HostWorktreeTarget
} from '../../../../shared/worktree/host-qualified-identity'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import '../../../../shared/workspace-layout/stable-pane-id'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../../../shared/worktree/id'
import { OrcaRuntimeService } from '../../orca-runtime'

// Folder workspaces share a directory; retain ::workspace:<uuid> to distinguish their PTYs.
const REPO_ID = 'repo-1'
const FOLDER_PATH = '/tmp/folder-project'
const ROOT_ID = `${REPO_ID}::${FOLDER_PATH}`
const WORKSPACE_A = `${ROOT_ID}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
const WORKSPACE_B = `${ROOT_ID}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`
const PTY_A = `${WORKSPACE_A}@@pty-a`
const PTY_B = `${WORKSPACE_B}@@pty-b`

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
  acquireWorktreeTerminalSpawn: (target: HostWorktreeTarget | undefined) => Promise<() => void>
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
    processLists?: unknown[][]
  } = {}
): RuntimeInternals {
  const meta: Record<string, Record<string, unknown>> = {
    [WORKSPACE_A]: { hostId: 'local' },
    [WORKSPACE_B]: { hostId: 'local' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This runtime fixture supplies the persistence and graph methods exercised by the test.
  const store = withDurableRuntimeStore({
    getRepos: () => [REPO],
    getRepo: (id: string) => (id === REPO_ID ? REPO : undefined),
    getAllWorktreeMeta: () => meta,
    getWorktreeMeta: (worktreeId: string) => meta[worktreeId],
    setWorktreeMeta: ({ id: worktreeId }: HostWorktreeTarget, patch: Record<string, unknown>) => {
      meta[worktreeId] = { ...meta[worktreeId], ...patch }
      return meta[worktreeId]
    },
    getWorkspaceSession: () => options.session ?? getDefaultWorkspaceSession(),
    setWorkspaceSession: () => {},
    flushOrThrow: () => {}
  }) as never
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

/** Drain microtasks to test promise-only lease contention without wall-clock delays. */
async function raceAgainstMicrotaskDrain(pending: Promise<unknown>): Promise<string> {
  return await Promise.race([
    pending.then(() => 'acquired'),
    new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 0))
  ])
}

describe('folder workspaces sharing one directory', () => {
  it('leaves a sleeping instance asleep when a sibling instance spawns a terminal', async () => {
    const internals = createRuntimeInternals({
      processLists: [[{ id: PTY_A, worktreeId: WORKSPACE_A, cwd: FOLDER_PATH, title: 'a' }], []]
    })
    const events: RuntimeClientEvent[] = []
    internals.onClientEvent((event) => events.push(event))

    await internals.sleepTerminalsForWorktree(`id:${WORKSPACE_A}`)
    const release = await internals.acquireWorktreeTerminalSpawn(
      spawnWorktreeTarget(WORKSPACE_B, null)
    )
    release()

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
    const releaseA = await internals.acquireWorktreeTerminalSpawn(
      spawnWorktreeTarget(WORKSPACE_A, null)
    )

    const spawnB = internals.acquireWorktreeTerminalSpawn(spawnWorktreeTarget(WORKSPACE_B, null))
    expect(await raceAgainstMicrotaskDrain(spawnB)).toBe('acquired')

    // Spawns intentionally share the lock; use sleep as the exclusive positive control.
    const sleepA = internals.sleepTerminalsForWorktree(`id:${WORKSPACE_A}`)
    expect(await raceAgainstMicrotaskDrain(sleepA)).toBe('blocked')

    releaseA()
    ;(await spawnB)()
    await sleepA
  })

  it('grants concurrent spawns for one instance while still excluding its sleep', async () => {
    const internals = createRuntimeInternals({ processLists: [[], []] })
    const releaseFirst = await internals.acquireWorktreeTerminalSpawn(
      spawnWorktreeTarget(WORKSPACE_A, null)
    )
    // Share concurrent tab spawns to avoid an activation latency staircase.
    const second = internals.acquireWorktreeTerminalSpawn(spawnWorktreeTarget(WORKSPACE_A, null))
    expect(await raceAgainstMicrotaskDrain(second)).toBe('acquired')

    const sleepA = internals.sleepTerminalsForWorktree(`id:${WORKSPACE_A}`)
    expect(await raceAgainstMicrotaskDrain(sleepA)).toBe('blocked')

    releaseFirst()
    ;(await second)()
    await sleepA
  })
})
