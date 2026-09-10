import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { retryLoadedStructuredAgentSessionSettlement } from './structured-agent-session-settlement-retry'
import {
  isStructuredAgentSessionRecoveryTicketCurrent,
  settleUnexpectedStructuredAgentSessionExit,
  type StructuredAgentSessionRecoveryTicket
} from './structured-agent-session-unexpected-exit'

const SESSION = 'session-1'
const GENERATION = 'generation-1'

const ticket: StructuredAgentSessionRecoveryTicket = {
  sessionId: SESSION,
  releasedFence: 8,
  deadAcquisitionGeneration: GENERATION,
  stableSettlementId: 'settlement-1',
  settlementRetryRequired: false
}

function recoveryContext(input: {
  generation?: string
  handoffStage?: AgentSessionRecord['lease']['handoffStage']
  resumeCapable?: boolean
}) {
  const session = {
    hasProviderChild: false,
    fence: 8,
    acquisitionGeneration: input.generation ?? GENERATION
  } as StructuredAgentSessionHostSession
  const record = {
    lease: {
      runtimeFence: 8,
      claimStatus: 'released',
      handoffStage: input.handoffStage ?? null
    }
  } as AgentSessionRecord
  return {
    sessions: new Map([[SESSION, session]]),
    store: { getRecord: () => record },
    hasResumeCapableHolder: () => input.resumeCapable ?? true
  } as never
}

function lifecycleItem(
  turnId: string,
  sequence: number,
  turnLifecycle: { state: 'running' | 'completed'; startedAt: number; completedAt?: number }
): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey({ provider: 'codex', threadId: 'thread-1', turnId, ordinal: 0 }),
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'turn', turnId, ...turnLifecycle }
  }
}

describe('provider-exit recovery tickets', () => {
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
    const session = {
      hasProviderChild: true,
      fence: 7,
      acquisitionGeneration: GENERATION,
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
        hasResumeCapableHolder: () => true,
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
        session: { journal: session.journal, fence: 8, acquisitionGeneration: null },
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
    const session = {
      hasProviderChild: true,
      fence: 7,
      acquisitionGeneration: GENERATION,
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

    const result = await settleUnexpectedStructuredAgentSessionExit(
      {
        store,
        sessions: new Map([[SESSION, session]]),
        flushLifecycle: async () => ({ ok: true }),
        publishFence: vi.fn(),
        hasResumeCapableHolder: () => true,
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

    expect(result).toMatchObject({ settlementRetryRequired: false, releasedFence: 8 })
    expect(session.journal.markPendingSubmissionsUnknown).toHaveBeenCalledWith(
      7,
      'provider_exited_before_acknowledgement'
    )
    expect(session.hasProviderChild).toBe(false)
    // The running row is revised to interrupted at exit receipt, never tombstoned.
    expect(appendLifecycleBatch).toHaveBeenCalledExactlyOnceWith({
      settlementId: `provider-exit:${SESSION}:7:${GENERATION}`,
      fence: 7,
      recovered: true,
      mutations: [
        {
          kind: 'item',
          identity: {
            provider: 'orca',
            clientMessageId: `provider-exit:${SESSION}:7:${GENERATION}`
          },
          body: { kind: 'status', text: 'Provider exited: provider exited' }
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

  it('does not release or reacquire while terminal settlement retry is still failing', async () => {
    const session = {
      hasProviderChild: true,
      fence: 7,
      acquisitionGeneration: GENERATION,
      journal: {
        markPendingSubmissionsUnknown: vi.fn(async () => []),
        snapshot: () => ({ items: [] }),
        appendLifecycleBatch: vi.fn(async () => {
          throw new Error('journal still unavailable')
        })
      }
    } as unknown as StructuredAgentSessionHostSession
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
    const result = await settleUnexpectedStructuredAgentSessionExit(
      {
        store: {
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
        },
        sessions: new Map([[SESSION, session]]),
        flushLifecycle: async () => ({ ok: false, error: new Error('sink failed') }),
        publishFence,
        hasResumeCapableHolder: () => true,
        serialize: async (_sessionId, task) => task(),
        now: () => 1,
        onBarrierError: release
      } as never,
      event
    )

    expect(result).toBeNull()
    expect(session.hasProviderChild).toBe(false)
    expect(session.fence).toBe(8)
    expect(publishFence).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(2)
  })

  it('admits the exact released generation for a resume-capable holder', () => {
    expect(isStructuredAgentSessionRecoveryTicketCurrent(recoveryContext({}), ticket)).toBe(true)
  })

  it('is cancelled by a queued handoff before reattachment', () => {
    expect(
      isStructuredAgentSessionRecoveryTicketCurrent(
        recoveryContext({ handoffStage: 'preparing' }),
        ticket
      )
    ).toBe(false)
  })

  it('is cancelled when its holder or dead acquisition generation is no longer current', () => {
    expect(
      isStructuredAgentSessionRecoveryTicketCurrent(
        recoveryContext({ resumeCapable: false }),
        ticket
      )
    ).toBe(false)
    expect(
      isStructuredAgentSessionRecoveryTicketCurrent(
        recoveryContext({ generation: 'generation-new' }),
        ticket
      )
    ).toBe(false)
  })
})
