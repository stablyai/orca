import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { unexpectedProviderExitOutcome } from './structured-agent-session-dead-generation-settlement'
import { retryLoadedStructuredAgentSessionSettlement } from './structured-agent-session-settlement-retry'
import {
  settleUnexpectedStructuredAgentSessionExit,
  type StructuredAgentSessionUnexpectedExitContext,
  type StructuredAgentSessionUnexpectedExitSession
} from './structured-agent-session-unexpected-exit'

const SESSION = 'session-1'
const GENERATION = 'generation-1'

function lifecycleItem(
  turnId: string,
  sequence: number,
  turnLifecycle: {
    state: 'running' | 'completed' | 'interrupted'
    startedAt: number
    completedAt?: number
  }
): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey({ provider: 'codex', threadId: 'thread-1', turnId, ordinal: 0 }),
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'turn', turnId, ...turnLifecycle }
  }
}

function liveRecord(): AgentSessionRecord {
  return agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId: SESSION,
      runtimeKind: 'native',
      runtimeFence: 7,
      handoffStage: null,
      ownerProcess: {
        hostId: 'local',
        pid: 4242,
        processStartTimeMs: 1,
        spawnToken: 'spawn-1'
      },
      reservedSpawnToken: 'spawn-1',
      claimStatus: 'live',
      unreconciled: false
    })
  )
}

function mutableStore() {
  let record = liveRecord()
  return {
    store: {
      getRecord: () => record,
      transitionHandoff: async (
        _sessionId: string,
        transition: (current: AgentSessionRecord) => AgentSessionRecord
      ) => (record = transition(record))
    }
  }
}

describe('provider-exit settlement', () => {
  it.each([undefined, 2_000])('keeps exit receipt %s on retry', async (observedAt) => {
    let now = observedAt === undefined ? 2_000 : 30_000
    let record = {
      lease: {
        handoffStage: null,
        runtimeFence: 7,
        runtimeKind: 'native',
        claimStatus: 'live',
        ownerProcess: 'provider',
        reservedSpawnToken: null,
        processlessAt: null
      }
    } as unknown as AgentSessionRecord
    const store = {
      getRecord: () => record,
      transitionHandoff: async (
        _sessionId: string,
        transition: (current: AgentSessionRecord) => AgentSessionRecord
      ) => (record = transition(record))
    }
    const appendLifecycleBatch = vi
      .fn()
      .mockRejectedValueOnce(new Error('journal unavailable'))
      .mockResolvedValue({ epoch: 'epoch-1', sequence: 2 })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exit reads only the child record and these journal methods; the rest of the session is unreachable from it.
    const session = {
      child: { generation: GENERATION, fence: 7, phase: 'ready' },
      journal: {
        snapshot: () => ({
          items: [lifecycleItem('turn-1', 1, { state: 'running', startedAt: 1_000 })]
        }),
        appendLifecycleBatch,
        markPendingSubmissionsUnknown: vi.fn(async () => [])
      }
    } as unknown as StructuredAgentSessionHostSession

    await settleUnexpectedStructuredAgentSessionExit(
      {
        store,
        sessions: new Map([[SESSION, session]]),
        flushLifecycle: async () => {
          now = 60_000
          return { ok: false, error: new Error('sink unavailable') }
        },
        publishFence: vi.fn(),
        serialize: async (_sessionId, task) => task(),
        now: () => now
      } as never,
      {
        type: 'ended',
        sessionId: SESSION,
        reason: 'provider exited',
        cause: 'unexpected-exit',
        fence: 7,
        acquisitionGeneration: GENERATION,
        observedAt
      }
    )
    expect(record.lease.settlementRetryRequired).toBe(true)
    expect(record.lease.deathEvidence?.observedAt).toBe(2_000)
    expect(record.lease.lastRenewedAt).toBe(60_000)
    expect(record.updatedAt).toBe(60_000)

    now = 120_000
    await expect(
      retryLoadedStructuredAgentSessionSettlement({
        deps: { store } as never,
        sessionId: SESSION,
        journal: session.journal,
        now: () => now
      })
    ).resolves.toBe(true)
    expect(appendLifecycleBatch.mock.calls.at(-1)?.[0].mutations).toContainEqual(
      expect.objectContaining({
        body: {
          kind: 'turn',
          turnId: 'turn-1',
          state: 'interrupted',
          startedAt: 1_000,
          completedAt: 2_000
        }
      })
    )
    expect(record.lease.settlementRetryRequired).toBeUndefined()
  })

  it('uses the fallback when the one-shot translator admission was rejected, revising the running turn in place', async () => {
    const appendLifecycleBatch = vi.fn(async () => ({ epoch: 'epoch-1', sequence: 3 }))
    const items = [
      lifecycleItem('turn-1', 1, { state: 'completed', startedAt: 10, completedAt: 20 }),
      lifecycleItem('turn-2', 2, { state: 'running', startedAt: 30 })
    ]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exit reads only the child record and these journal methods; the rest of the session is unreachable from it.
    const session = {
      child: { generation: GENERATION, fence: 7, phase: 'ready' },
      journal: {
        snapshot: () => ({ items }),
        appendLifecycleBatch,
        markPendingSubmissionsUnknown: vi.fn(async () => [])
      }
    } as unknown as StructuredAgentSessionHostSession
    const store = {
      getRecord: () => ({
        lease: {
          handoffStage: null,
          runtimeFence: 7,
          runtimeKind: 'native',
          claimStatus: 'live',
          ownerProcess: 'provider',
          reservedSpawnToken: null,
          processlessAt: null
        }
      }),
      transitionHandoff: async () => ({ lease: { runtimeFence: 8 } })
    }

    await settleUnexpectedStructuredAgentSessionExit(
      {
        store,
        sessions: new Map([[SESSION, session]]),
        flushLifecycle: async () => ({ ok: true }),
        publishFence: vi.fn(),
        serialize: async (_sessionId, task) => task(),
        now: () => 1_234
      } as never,
      {
        type: 'ended',
        sessionId: SESSION,
        reason: 'provider exited',
        cause: 'unexpected-exit',
        fence: 7,
        acquisitionGeneration: GENERATION,
        settlementRetryRequired: true
      }
    )

    expect(session.journal.markPendingSubmissionsUnknown).toHaveBeenCalledWith(
      7,
      'provider_exited_before_acknowledgement'
    )
    expect(session.child).toBeNull()
    // The running row is revised to interrupted at exit receipt, never tombstoned.
    expect(appendLifecycleBatch).toHaveBeenCalledExactlyOnceWith({
      settlementId: `dead-generation:provider-exit:${SESSION}:7:${GENERATION}`,
      fence: 7,
      recovered: true,
      mutations: [
        {
          kind: 'item',
          identity: {
            provider: 'orca',
            clientMessageId: `provider-exit:${SESSION}:7:${GENERATION}`
          },
          body: { kind: 'status', text: unexpectedProviderExitOutcome('provider exited') }
        },
        {
          kind: 'item',
          identity: { provider: 'codex', threadId: 'thread-1', turnId: 'turn-2', ordinal: 0 },
          body: {
            kind: 'turn',
            turnId: 'turn-2',
            state: 'interrupted',
            startedAt: 30,
            completedAt: 1_234
          }
        }
      ]
    })
  })

  it.each([
    { initialState: 'running' as const, terminalState: 'completed' as const, expectedOutcomes: 0 },
    {
      initialState: 'running' as const,
      terminalState: 'interrupted' as const,
      expectedOutcomes: 1
    },
    {
      initialState: 'interrupted' as const,
      terminalState: 'interrupted' as const,
      expectedOutcomes: 1
    }
  ])(
    'reports $expectedOutcomes outcome(s) when the barrier sees $initialState then $terminalState',
    async ({ initialState, terminalState, expectedOutcomes }) => {
      let items = [
        lifecycleItem('turn-1', 1, {
          state: initialState,
          startedAt: 30,
          ...(initialState === 'running' ? {} : { completedAt: 40 })
        })
      ]
      const appendLifecycleBatch = vi.fn(async (_input: { mutations: readonly unknown[] }) => ({
        epoch: 'epoch-1',
        sequence: 3
      }))
      const session: StructuredAgentSessionUnexpectedExitSession = {
        child: { generation: GENERATION, fence: 7, phase: 'ready' },
        journal: {
          snapshot: () => ({ items }),
          appendLifecycleBatch,
          markPendingSubmissionsUnknown: vi.fn(async () => []),
          rejectPendingSubmissions: vi.fn(async () => [])
        }
      }

      const { store } = mutableStore()
      const context: StructuredAgentSessionUnexpectedExitContext<typeof session> = {
        store,
        sessions: new Map([[SESSION, session]]),
        flushLifecycle: async () => {
          items = [
            lifecycleItem('turn-1', 1, {
              state: terminalState,
              startedAt: 30,
              completedAt: 40
            })
          ]
          return { ok: true }
        },
        publishFence: vi.fn(),
        serialize: async <T>(_sessionId: string, task: () => Promise<T>) => task(),
        now: () => 1_234
      }
      await settleUnexpectedStructuredAgentSessionExit(context, {
        type: 'ended',
        sessionId: SESSION,
        reason: 'provider exited after completing the turn',
        cause: 'unexpected-exit',
        fence: 7,
        acquisitionGeneration: GENERATION,
        observedAt: 40
      })

      expect(appendLifecycleBatch).toHaveBeenCalledTimes(expectedOutcomes)
      if (expectedOutcomes > 0) {
        expect(appendLifecycleBatch.mock.calls[0]?.[0].mutations).toEqual([
          expect.objectContaining({
            body: {
              kind: 'status',
              text: unexpectedProviderExitOutcome('provider exited after completing the turn')
            }
          })
        ])
      }
    }
  )

  it('settles a submission the dead child never acknowledged', async () => {
    const markPendingSubmissionsUnknown = vi.fn(async () => ['client-1'])
    const session: StructuredAgentSessionUnexpectedExitSession = {
      child: { generation: GENERATION, fence: 7, phase: 'ready' },
      journal: {
        snapshot: () => ({ items: [] }),
        appendLifecycleBatch: vi.fn(async () => ({ epoch: 'epoch-1', sequence: 1 })),
        markPendingSubmissionsUnknown,
        rejectPendingSubmissions: vi.fn(async () => []),
        submissions: () => [{ clientMessageId: 'client-1', dispatchState: 'pending' }]
      }
    }

    const { store } = mutableStore()
    const context: StructuredAgentSessionUnexpectedExitContext<typeof session> = {
      store,
      sessions: new Map([[SESSION, session]]),
      flushLifecycle: async () => ({ ok: true }),
      publishFence: vi.fn(),
      serialize: async <T>(_sessionId: string, task: () => Promise<T>) => task(),
      now: () => 1
    }
    await settleUnexpectedStructuredAgentSessionExit(context, {
      type: 'ended',
      sessionId: SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit',
      fence: 7,
      acquisitionGeneration: GENERATION
    })

    expect(markPendingSubmissionsUnknown).toHaveBeenCalledWith(
      7,
      'provider_exited_before_acknowledgement'
    )
    expect(session.journal.appendLifecycleBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        mutations: [
          expect.objectContaining({
            body: { kind: 'status', text: unexpectedProviderExitOutcome('provider exited') }
          })
        ]
      })
    )
  })

  it('does not release or reacquire while terminal settlement retry is still failing', async () => {
    const session: StructuredAgentSessionUnexpectedExitSession = {
      child: { generation: GENERATION, fence: 7, phase: 'ready' },
      journal: {
        markPendingSubmissionsUnknown: vi.fn(async () => []),
        rejectPendingSubmissions: vi.fn(async () => []),
        snapshot: () => ({
          items: [lifecycleItem('turn-failing', 1, { state: 'running', startedAt: 1 })]
        }),
        appendLifecycleBatch: vi.fn(async () => {
          throw new Error('journal still unavailable')
        })
      }
    }
    const release = vi.fn()
    const publishFence = vi.fn()
    const event = {
      type: 'ended' as const,
      sessionId: SESSION,
      reason: 'provider exited',
      cause: 'unexpected-exit' as const,
      fence: 7,
      acquisitionGeneration: GENERATION
    }
    const { store } = mutableStore()
    const context: StructuredAgentSessionUnexpectedExitContext<typeof session> = {
      store,
      sessions: new Map([[SESSION, session]]),
      flushLifecycle: async () => ({ ok: false, error: new Error('sink failed') }),
      publishFence,
      serialize: async (_sessionId, task) => task(),
      now: () => 1,
      onBarrierError: release
    }
    await settleUnexpectedStructuredAgentSessionExit(context, event)

    expect(session.child).toBeNull()
    expect(publishFence).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(2)
  })
})
