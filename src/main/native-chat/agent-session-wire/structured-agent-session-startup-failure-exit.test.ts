import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { providerStartupFailureOutcome } from './structured-agent-session-dead-generation-settlement'
import {
  settleUnexpectedStructuredAgentSessionExit,
  type StructuredAgentSessionUnexpectedExitContext,
  type StructuredAgentSessionUnexpectedExitSession
} from './structured-agent-session-unexpected-exit'

const SESSION = 'session-1'
const GENERATION = 'generation-1'
const REASON = 'Claude Code is not signed in. Sign in with the Claude CLI'

function startedSession(): StructuredAgentSessionUnexpectedExitSession & {
  journal: { appendLifecycleBatch: ReturnType<typeof vi.fn> }
} {
  return {
    child: { generation: GENERATION, fence: 7, phase: 'ready' },
    journal: {
      cursor: () => ({ epoch: 'epoch-1', sequence: 0 }),
      // Nothing ran: the start failed before any response or acknowledged prompt.
      snapshot: () => ({ items: [] }),
      appendLifecycleBatch: vi.fn(async () => ({ epoch: 'epoch-1', sequence: 1 })),
      markPendingSubmissionsUnknown: vi.fn(async () => []),
      rejectPendingSubmissions: vi.fn(async () => [])
    }
  }
}

function contextFor(session: StructuredAgentSessionUnexpectedExitSession) {
  let record: AgentSessionRecord = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      sessionId: SESSION,
      runtimeKind: 'native',
      runtimeFence: 7,
      handoffStage: null,
      ownerProcess: { hostId: 'local', pid: 4242, processStartTimeMs: 1, spawnToken: 'spawn-1' },
      reservedSpawnToken: 'spawn-1',
      claimStatus: 'live',
      unreconciled: false
    })
  )
  const context: StructuredAgentSessionUnexpectedExitContext<typeof session> = {
    store: {
      getRecord: () => record,
      transitionHandoff: async (
        _sessionId: string,
        transition: (current: AgentSessionRecord) => AgentSessionRecord
      ) => (record = transition(record))
    },
    sessions: new Map([[SESSION, session]]),
    flushLifecycle: async () => ({ ok: true }),
    publishFence: vi.fn(),
    hasResumeCapableHolder: () => true,
    serialize: async <T>(_sessionId: string, task: () => Promise<T>) => task(),
    now: () => 1
  }
  return context
}

const ended = {
  type: 'ended' as const,
  sessionId: SESSION,
  reason: REASON,
  cause: 'unexpected-exit' as const,
  fence: 7,
  acquisitionGeneration: GENERATION
}

describe('a provider that ends before it finished starting', () => {
  it('tells the user why, even with no response in progress, and does not auto-resume', async () => {
    const session = startedSession()

    const ticket = await settleUnexpectedStructuredAgentSessionExit(contextFor(session), {
      ...ended,
      startupUnproven: true
    })

    expect(ticket).toBeNull()
    expect(session.journal.appendLifecycleBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        mutations: [
          expect.objectContaining({
            // The same row the delivery loop writes for a failed start: an error, keyed by it.
            identity: { provider: 'orca', clientMessageId: `start-failure:${GENERATION}` },
            body: { kind: 'status', text: providerStartupFailureOutcome(REASON), tone: 'error' }
          })
        ]
      })
    )
    expect(providerStartupFailureOutcome(REASON)).toContain('not signed in')
  })

  it('keeps an ordinary idle exit silent and resumable', async () => {
    const session = startedSession()

    const ticket = await settleUnexpectedStructuredAgentSessionExit(contextFor(session), ended)

    expect(ticket).not.toBeNull()
    expect(session.journal.appendLifecycleBatch).not.toHaveBeenCalled()
  })

  it("reads a start that failed off the host's own phase when the provider omits the flag", async () => {
    const session = {
      ...startedSession(),
      child: { generation: GENERATION, fence: 7, phase: 'starting' as const }
    }

    const ticket = await settleUnexpectedStructuredAgentSessionExit(contextFor(session), ended)

    expect(ticket).toBeNull()
    expect(session.journal.appendLifecycleBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        mutations: [
          expect.objectContaining({
            // The same row the delivery loop writes for a failed start: an error, keyed by it.
            identity: { provider: 'orca', clientMessageId: `start-failure:${GENERATION}` },
            body: { kind: 'status', text: providerStartupFailureOutcome(REASON), tone: 'error' }
          })
        ]
      })
    )
  })
})
