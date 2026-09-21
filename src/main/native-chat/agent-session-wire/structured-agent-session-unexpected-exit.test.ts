import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
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

describe('provider-exit recovery tickets', () => {
  it('uses the fallback when the one-shot translator admission was rejected', async () => {
    const appendLifecycleBatch = vi.fn(async () => ({ epoch: 'epoch-1', sequence: 1 }))
    const session = {
      hasProviderChild: true,
      fence: 7,
      acquisitionGeneration: GENERATION,
      journal: { snapshot: () => ({ items: [] }), appendLifecycleBatch }
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
        now: () => 1
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
    expect(appendLifecycleBatch).toHaveBeenCalledOnce()
    expect(session.hasProviderChild).toBe(false)
  })

  it('does not release or reacquire while terminal settlement retry is still failing', async () => {
    const session = {
      hasProviderChild: true,
      fence: 7,
      acquisitionGeneration: GENERATION,
      journal: {
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
