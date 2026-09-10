import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

const hostRef: { current: unknown } = { current: null }

vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { listAddressableStructuredWorkers, structuredWorkerAgentStatus } =
  await import('./structured-worker-group-addressing')
const { resolveGroupAddress } = await import('./groups')
const { sendGroupMessage } = await import('../rpc/methods/orchestration/messaging/send-group')
const {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} = await import('../structured-worker-identity')

const SESSION_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'

function idleTurn(): AgentJournalRenderItem {
  return {
    itemId: 'lifecycle-1',
    body: { kind: 'status', text: 'done', turnLifecycle: { turnId: 't1', state: 'completed' } }
  } as unknown as AgentJournalRenderItem
}

function runningTurn(): AgentJournalRenderItem {
  return {
    itemId: 'lifecycle-1',
    body: { kind: 'status', text: 'working', turnLifecycle: { turnId: 't1', state: 'running' } }
  } as unknown as AgentJournalRenderItem
}

function transcript(count: number): AgentJournalRenderItem[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      ({
        itemId: `tool-${index}`,
        body: { kind: 'tool-call', name: 'Bash', input: {}, state: 'completed' }
      }) as unknown as AgentJournalRenderItem
  )
}

function installHost(options: {
  items?: AgentJournalRenderItem[]
  lease?: { runtimeKind: string; claimStatus: string }
  hasSession?: boolean
}): void {
  const lease = options.lease ?? { runtimeKind: 'native', claimStatus: 'live' }
  hostRef.current = {
    deps: {
      store: {
        getRecord: (sessionId: string) =>
          ({
            sessionId,
            provider: 'codex',
            location: { executionHostId: 'local', wslDistro: null },
            lease: { ...lease, runtimeFence: 1, deathEvidence: null }
          }) as unknown as AgentSessionRecord
      }
    },
    hasSession: () => options.hasSession ?? true,
    journalSnapshot: () => ({ items: options.items ?? [idleTurn()] })
  }
}

function registerWorker(worktreeId = 'wt_1'): string {
  const handle = mintStructuredWorkerHandle()
  structuredWorkerIdentities.register({
    handle,
    sessionId: SESSION_ID,
    agent: 'codex',
    paneKey: mintStructuredWorkerPaneKey(SESSION_ID),
    processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
    worktreeId,
    hostScope: { kind: 'local', hostId: 'local' }
  })
  return handle
}

const PTY_TERMINAL = { handle: 'term_a', worktreeId: 'wt_1', agentIdentity: 'claude' as const }

describe('group addressing and structured workers', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    hostRef.current = null
  })

  it('enumerates a live structured worker as a candidate', () => {
    const handle = registerWorker()
    installHost({})
    expect(listAddressableStructuredWorkers()).toEqual([
      { handle, worktreeId: 'wt_1', agentIdentity: 'codex' }
    ])
  })

  it('leaves out a worker whose session is not proven live', () => {
    // Addressing a settled worker would store mail no lane will ever deliver.
    registerWorker()
    installHost({ lease: { runtimeKind: 'native', claimStatus: 'live' }, hasSession: false })
    expect(listAddressableStructuredWorkers()).toEqual([])
  })

  it('reaches a structured worker through @all', () => {
    // The defect this pins: recipients came only from `listTerminals`, which enumerates leaves and
    // PTYs, so a structured worker was excluded BEFORE per-recipient resolution — the warning
    // machinery never ran and the sender got exit 0 with a receipt naming only who did resolve.
    const handle = registerWorker()
    installHost({})
    const recipients = [PTY_TERMINAL, ...listAddressableStructuredWorkers()]
    expect(resolveGroupAddress('@all', 'term_sender', recipients, () => 'idle')).toContain(handle)
  })

  it('reaches a structured worker through @worktree: and @codex, but not @claude', () => {
    const handle = registerWorker('wt_2')
    installHost({})
    const recipients = [PTY_TERMINAL, ...listAddressableStructuredWorkers()]
    expect(resolveGroupAddress('@worktree:wt_2', 'term_sender', recipients, () => 'idle')).toEqual([
      handle
    ])
    expect(resolveGroupAddress('@codex', 'term_sender', recipients, () => 'idle')).toEqual([handle])
    expect(resolveGroupAddress('@claude', 'term_sender', recipients, () => 'idle')).toEqual([
      'term_a'
    ])
  })

  it('reads @idle status off the FULL timeline, never a bounded tail', () => {
    // The same trap that already cost this branch once: settlement tombstones the lifecycle item
    // rather than rewriting it, so a long tool-calling turn pushes it arbitrarily far from the
    // tail and any page-sized read reports a BUSY worker as idle — then `@idle` broadcasts into a
    // running turn, which Codex refuses outright and Claude queues behind.
    registerWorker()
    installHost({ items: [runningTurn(), ...transcript(500)] })
    expect(structuredWorkerAgentStatus(SESSION_ID)).toBe('working')
  })

  it('answers idle only when no turn is running and no human is awaited', () => {
    registerWorker()
    installHost({ items: [idleTurn()] })
    expect(structuredWorkerAgentStatus(SESSION_ID)).toBe('idle')
    installHost({
      items: [
        {
          itemId: 'q1',
          body: {
            kind: 'question',
            question: 'which?',
            options: [],
            resolution: { state: 'pending' }
          }
        } as unknown as AgentJournalRenderItem
      ]
    })
    expect(structuredWorkerAgentStatus(SESSION_ID)).toBe('attention')
  })

  it('answers null rather than idle when the session cannot be read', () => {
    // Unknown must never read as idle, or `@idle` wakes a worker mid-turn.
    hostRef.current = null
    expect(structuredWorkerAgentStatus(SESSION_ID)).toBeNull()
  })
})

describe('sendGroupMessage actually composes structured workers in', () => {
  beforeEach(() => {
    structuredWorkerIdentities.clear()
    hostRef.current = null
  })

  /**
   * Drives the real `sendGroupMessage`, not `resolveGroupAddress`.
   *
   * The suite above hand-composed `[PTY_TERMINAL, ...listAddressableStructuredWorkers()]` itself,
   * so deleting the composition at the call site left it green — the exact regression the fix
   * describes could come straight back. This test owns that seam.
   */
  it('addresses a structured worker that only the call site can enumerate', async () => {
    const handle = registerWorker('wt_2')
    installHost({})
    const inserted: { to: string }[] = []
    const db = {
      getLegacyAdoptedRunMailboxOwner: () => null,
      getCurrentRunForPane: () => undefined,
      getActiveDispatchMailboxOwners: () => [],
      getRunMailboxOwnerIdsForHandle: () => [],
      insertMessages: (rows: { to: string }[]) => {
        inserted.push(...rows)
        return rows.map((row, index) => ({ id: `m${index}`, to_handle: row.to, type: 'status' }))
      }
    }
    const runtime = {
      // No PTY terminals at all: if the call site does not compose structured workers in, the
      // group resolves empty and this throws instead of delivering.
      listTerminals: async () => ({ terminals: [] }),
      getAgentStatusForHandle: () => 'idle',
      getLiveTerminalPaneKey: () => structuredWorkerIdentities.get(handle)!.paneKey,
      notifyMessageArrived: () => {}
    }
    await sendGroupMessage({
      params: { subject: 's', body: 'b', type: 'status', priority: 'normal' },
      runtime: runtime as never,
      db: db as never,
      from: 'term_sender',
      // `@worktree:` is the one group that still enumerates agents; the Run groups read
      // Dispatch rows, where a structured worker's identity is looked up by this same handle.
      groupAddress: '@worktree:wt_2',
      senderPaneKey: undefined,
      senderRunId: undefined,
      explicitRunId: undefined,
      legacyCoordinatorRunId: undefined,
      revalidateLegacyCoordinator: undefined,
      recordMutationReceipt: undefined,
      withSendWarnings: (receipt) => receipt
    } as never)
    expect(inserted.map((row) => row.to)).toEqual([handle])
  })

  it('reads a structured worker identity for @codex off its Dispatch row handle', async () => {
    const handle = registerWorker()
    installHost({})
    const inserted: { to: string }[] = []
    const db = {
      getLegacyAdoptedRunMailboxOwner: () => null,
      getCurrentRunForPane: () => undefined,
      getActiveDispatchForIdentity: () => ({ run_id: 'run_1' }),
      getActiveDispatchMailboxOwners: () => [],
      getRunMailboxOwnerIdsForHandle: () => [],
      listWorkerTerminalResources: () => [
        {
          dispatchId: 'ctx_structured',
          runId: 'run_1',
          dispatchStatus: 'dispatched',
          agentTerminalHandle: handle,
          worktreeId: 'wt_1'
        },
        {
          dispatchId: 'ctx_pty_claude',
          runId: 'run_1',
          dispatchStatus: 'dispatched',
          agentTerminalHandle: 'term_claude',
          worktreeId: 'wt_1'
        }
      ],
      listFederatedDispatchesByIds: () => [],
      getDispatchContextById: () => undefined,
      insertMessages: (rows: { to: string }[]) => {
        inserted.push(...rows)
        return rows.map((row, index) => ({ id: `m${index}`, to_handle: row.to, type: 'status' }))
      }
    }
    const runtime = {
      listTerminals: async () => ({
        terminals: [{ handle: 'term_claude', worktreeId: 'wt_1', agentIdentity: 'claude' }]
      }),
      getAgentStatusForHandle: () => 'idle',
      getLiveTerminalPaneKey: () => null,
      getOrchestrationDb: () => db,
      notifyMessageArrived: () => {}
    }
    await sendGroupMessage({
      params: { subject: 's', body: 'b', type: 'status', priority: 'normal' },
      runtime: runtime as never,
      db: db as never,
      from: 'term_sender',
      groupAddress: '@codex',
      senderPaneKey: undefined,
      senderRunId: 'run_1',
      explicitRunId: undefined,
      legacyCoordinatorRunId: undefined,
      revalidateLegacyCoordinator: undefined,
      recordMutationReceipt: undefined,
      withSendWarnings: (receipt) => receipt
    } as never)
    expect(inserted.map((row) => row.to)).toEqual(['dispatch:ctx_structured'])
  })
})
