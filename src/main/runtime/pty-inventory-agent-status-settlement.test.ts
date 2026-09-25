import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { makePaneKey } from '../../shared/stable-pane-id'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { OrcaRuntimeService } from './orca-runtime'
import type { AgentStatusPtyInventoryCandidate } from '../agent-hooks/server/server-pty-inventory-settlement'

// The settlement is the SECOND consumer of one host-scoped inventory answer. These pin the wiring:
// every call site that produces an answer hands it over, with its own connection scope intact.
const REPO_ID = 'repo-1'
const REPO_PATH = '/tmp/inventory-settlement'
const WORKSPACE = `${REPO_ID}::${REPO_PATH}`
const LIVE_PTY = `${WORKSPACE}@@live-pty`
const TAB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LEAF_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const SSH_TARGET = 'host-a'

const REPO = {
  id: REPO_ID,
  path: REPO_PATH,
  displayName: 'inventory-settlement',
  badgeColor: 'blue',
  addedAt: 1,
  kind: 'git'
} as const

type SettlementCall = {
  connectionId: string | null | undefined
  queriedHostIds: string[]
  allLivePtyIds: string[]
}

type RuntimeInternals = {
  buildResolvedWorktreeFromId: (worktreeId: string) => unknown
  refreshPtyWorktreeRecordsWithControllerInventory: (
    resolvedWorktrees: unknown[],
    targetWorktreeId?: string | null,
    deadline?: number,
    connectionId?: string | null
  ) => Promise<unknown>
  settleAgentStatusRowsAbsentFromInventory: (answer: {
    connectionId: string | null | undefined
    queriedHostIds: ReadonlySet<string>
    allLivePtyIds: ReadonlySet<string>
  }) => Promise<number>
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: Record<string, unknown>
  ) => Record<string, unknown>
}

function createRuntime(
  options: {
    sessions?: { id: string; cwd: string; worktreeId: string }[]
    candidates?: AgentStatusPtyInventoryCandidate[]
    /** Reproduces a host whose provider cannot enumerate anything at all. */
    withoutListProcesses?: boolean
  } = {}
): {
  internals: RuntimeInternals
  calls: SettlementCall[]
  settle: ReturnType<typeof vi.fn>
} {
  const meta: Record<string, Record<string, unknown>> = { [WORKSPACE]: { hostId: 'local' } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double for the store surface this runtime reads; the full RuntimeStore is not constructible here.
  const store = {
    getRepos: () => [REPO],
    getRepo: (id: string) => (id === REPO_ID ? REPO : undefined),
    getAllWorktreeMeta: () => meta,
    getWorktreeMeta: (worktreeId: string) => meta[worktreeId],
    setWorktreeMeta: (worktreeId: string, patch: Record<string, unknown>) => {
      meta[worktreeId] = { ...meta[worktreeId], ...patch }
      return meta[worktreeId]
    },
    getFolderWorkspace: () => undefined,
    getProjectGroups: () => [],
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    setWorkspaceSession: () => {},
    flushOrThrow: () => {}
  } as never
  const calls: SettlementCall[] = []
  const settle = vi.fn(() => 0)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the settlement dep is under test here; every other runtime dep is optional.
  const runtime = new OrcaRuntimeService(store, undefined, {
    agentStatusPtyInventorySettlement: {
      listCandidates: () => {
        return options.candidates ?? []
      },
      settle
    }
  } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller contract is almost entirely optional; these are the members this path calls.
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    hasPty: () => null,
    probePtyLiveness: async () => false,
    ...(options.withoutListProcesses ? {} : { listProcesses: async () => options.sessions ?? [] })
  } as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the inventory pass and its settlement are protected; this spec drives them directly, as its sibling inventory specs do.
  const internals = runtime as unknown as RuntimeInternals
  const real = internals.settleAgentStatusRowsAbsentFromInventory.bind(internals)
  internals.settleAgentStatusRowsAbsentFromInventory = async (answer) => {
    calls.push({
      connectionId: answer.connectionId,
      queriedHostIds: [...answer.queriedHostIds],
      allLivePtyIds: [...answer.allLivePtyIds]
    })
    return await real(answer)
  }
  return { internals, calls, settle }
}

function candidate(
  overrides: Partial<AgentStatusPtyInventoryCandidate> = {}
): AgentStatusPtyInventoryCandidate {
  return {
    paneKey: PANE_KEY,
    connectionId: null,
    worktreeId: WORKSPACE,
    receivedAt: 1_000,
    stateStartedAt: 1_000,
    ...overrides
  }
}

describe('agent status settles from the host PTY inventory', () => {
  it('hands every completed local pass its own answer', async () => {
    const { internals, calls } = createRuntime({
      sessions: [{ id: LIVE_PTY, cwd: REPO_PATH, worktreeId: WORKSPACE }]
    })

    await internals.refreshPtyWorktreeRecordsWithControllerInventory(
      [internals.buildResolvedWorktreeFromId(WORKSPACE)],
      null,
      undefined,
      null
    )

    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]).toEqual({
      connectionId: null,
      queriedHostIds: ['local'],
      allLivePtyIds: [LIVE_PTY]
    })
  })

  it('carries the SSH target scope of a per-connection pass', async () => {
    const { internals, calls } = createRuntime()

    await internals.refreshPtyWorktreeRecordsWithControllerInventory(
      [internals.buildResolvedWorktreeFromId(WORKSPACE)],
      null,
      undefined,
      SSH_TARGET
    )

    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.connectionId).toBe(SSH_TARGET)
    expect(calls[0]!.queriedHostIds).toEqual([toSshExecutionHostId(SSH_TARGET)])
  })

  it('carries the aggregate scope of a pass that named no connection', async () => {
    const { internals, calls } = createRuntime()

    await internals.refreshPtyWorktreeRecordsWithControllerInventory([
      internals.buildResolvedWorktreeFromId(WORKSPACE)
    ])

    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]!.connectionId).toBeUndefined()
  })

  it('settles a pane whose persisted PTY the answering host does not list', async () => {
    const { internals, settle } = createRuntime({ candidates: [candidate()] })
    // The pane's PTY is bound in this runtime and absent from the listing.
    internals.recordPtyWorktree(`${WORKSPACE}@@dead-pty`, WORKSPACE, {
      connected: true,
      tabId: TAB_ID,
      paneKey: PANE_KEY
    })

    await internals.refreshPtyWorktreeRecordsWithControllerInventory(
      [internals.buildResolvedWorktreeFromId(WORKSPACE)],
      null,
      undefined,
      null
    )

    await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(1))
    expect(settle.mock.calls[0]![0]).toEqual([candidate()])
  })

  it('offers nothing when no provider could be listed at all', async () => {
    // The positive control is the local pass above: same runtime, same candidate, one call.
    const { internals, calls, settle } = createRuntime({
      candidates: [candidate()],
      withoutListProcesses: true
    })

    expect(
      await internals.refreshPtyWorktreeRecordsWithControllerInventory(
        [internals.buildResolvedWorktreeFromId(WORKSPACE)],
        null,
        undefined,
        null
      )
    ).toBeNull()
    expect(calls).toEqual([])
    expect(settle).not.toHaveBeenCalled()
  })
})
