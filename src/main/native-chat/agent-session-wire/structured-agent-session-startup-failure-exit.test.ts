import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import {
  settleStructuredAgentSessionChildExit,
  type StructuredAgentSessionChildExitContext,
  type StructuredAgentSessionChildExitSession
} from './structured-agent-session-child-exit'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

const SESSION = 'session-1'
const GENERATION = 'generation-1'
const REASON = 'claude stream-json exited (code 1): session limit reached'

function startedSession(): StructuredAgentSessionChildExitSession & {
  journal: {
    appendLifecycleBatch: ReturnType<typeof vi.fn>
    markPendingSubmissionsUnknown: ReturnType<typeof vi.fn>
  }
} {
  return {
    child: { generation: GENERATION, fence: 7, phase: 'ready' },
    journal: {
      cursor: () => ({ epoch: 'epoch-1', sequence: 0 }),
      itemBody: () => null,
      // Nothing ran: the start failed before any response or acknowledged prompt.
      snapshot: () => ({ items: [] }),
      appendLifecycleBatch: vi.fn(async () => ({ epoch: 'epoch-1', sequence: 1 })),
      markPendingSubmissionsUnknown: vi.fn(async () => [])
    }
  }
}

function contextFor(session: StructuredAgentSessionChildExitSession) {
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
  const context: StructuredAgentSessionChildExitContext<typeof session> = {
    logger: recordingStructuredAgentSessionLogger().logger,
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
    wakeDelivery: vi.fn(),
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
  it('writes nothing itself, and hands the failed start to the delivery loop', async () => {
    const session = startedSession()
    const context = contextFor(session)

    await settleStructuredAgentSessionChildExit(context, {
      ...ended,
      // The adapter typed the start's own failure; the loop words it on the message it was for.
      failure: { kind: 'notSignedIn' },
      startupUnproven: true
    })

    expect(session.journal.appendLifecycleBatch).not.toHaveBeenCalled()
    expect(session.journal.markPendingSubmissionsUnknown).not.toHaveBeenCalled()
    expect(session.child).toBeNull()
    expect(session.lastEndedChild).toMatchObject({
      cause: 'exit',
      duringStartup: true,
      failure: { kind: 'notSignedIn' }
    })
    expect(context.wakeDelivery).toHaveBeenCalledWith(SESSION)
  })

  it('keeps an ordinary idle exit silent', async () => {
    const session = startedSession()
    const context = contextFor(session)

    await settleStructuredAgentSessionChildExit(context, ended)

    expect(session.child).toBeNull()
    expect(session.journal.appendLifecycleBatch).not.toHaveBeenCalled()
  })

  it("reads a start that failed off the host's own phase when the provider omits the flag", async () => {
    const session = {
      ...startedSession(),
      child: { generation: GENERATION, fence: 7, phase: 'starting' as const }
    }
    const context = contextFor(session)

    await settleStructuredAgentSessionChildExit(context, {
      ...ended,
      failure: { kind: 'providerExited', detail: { text: REASON, audience: 'log' } }
    })

    expect(session.journal.appendLifecycleBatch).not.toHaveBeenCalled()
    expect(session.lastEndedChild).toMatchObject({ duringStartup: true })
    expect(context.wakeDelivery).toHaveBeenCalledWith(SESSION)
  })
})
