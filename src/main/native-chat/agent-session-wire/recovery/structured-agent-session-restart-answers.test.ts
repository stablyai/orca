import { afterEach, expect, it, vi } from 'vitest'
import { createRestartAnswers } from './structured-agent-session-restart-answers'
import {
  continuationDeps,
  startStructuredAgentSessionContinuation,
  type StructuredAgentSessionContinuationOutcome
} from './structured-agent-session-restart-continuation'
import {
  AGENT_SESSION_RESTART_CONTINUATION_NOTE,
  AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE
} from '../../../../shared/agent-session/lifecycle/stopping/agent-session-restart-continuation'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'

const logger: StructuredAgentSessionLogger = { warn: vi.fn(), error: vi.fn() }

afterEach(() => vi.useRealTimers())

it('returns before late answers, then settles them in one pass without dropping an unanswered record', async () => {
  vi.useFakeTimers()
  const settled: { ids: string[]; last: boolean; failure: (string | null)[] }[] = []
  const failures = {
    settle: vi.fn(async (_op, outcomes, action, last = true) => {
      const ids = outcomes.map((outcome: { sessionId: string }) => outcome.sessionId)
      const failure = ids.map((id: string) => action.failureAfterResume(id))
      settled.push({ ids, last, failure })
      return ids.filter((_id: string, index: number) => failure[index] !== null)
    })
  }
  const answers = createRestartAnswers()
  const late = Promise.withResolvers<StructuredAgentSessionContinuationOutcome>()
  const giveUp = { fast: vi.fn(), refused: vi.fn(), stuck: vi.fn() }
  answers.handedOver(
    'fast',
    Promise.resolve({ sessionId: 'fast', outcome: 'continued' }),
    giveUp.fast
  )
  answers.handedOver('refused', late.promise, giveUp.refused)
  // Never answers, like an agent stuck retrying its API.
  answers.handedOver('stuck', new Promise(() => {}), giveUp.stuck)
  await Promise.resolve()

  const { waiting, settled: later } = await answers.settle(
    {
      operationId: 'op',
      outcomes: ['fast', 'refused', 'stuck'].map((sessionId) => ({
        sessionId,
        outcome: 'resumed' as const
      })),
      candidates: [],
      markers: new Map()
    },
    failures,
    logger
  )

  expect([...waiting]).toEqual(['refused', 'stuck'])
  expect(settled).toEqual([{ ids: ['fast'], last: false, failure: [null] }])

  late.resolve({
    sessionId: 'refused',
    outcome: 'refused',
    reason: 'agent_session_dispatch_rejected'
  })
  await vi.advanceTimersByTimeAsync(150_000)
  await later

  expect(settled).toEqual([
    { ids: ['fast'], last: false, failure: [null] },
    { ids: ['fast', 'refused', 'stuck'], last: true, failure: [null, 'refused', 'unconfirmed'] }
  ])
  expect([giveUp.fast.mock.calls.length, giveUp.refused.mock.calls.length]).toEqual([0, 0])
  expect(giveUp.stuck).toHaveBeenCalledOnce()
})

it('settles a chat its agent never answers on its own: no longer sending, queue released, noted', async () => {
  vi.useFakeTimers()
  type Row = { clientMessageId: string; dispatchState: string; handedOverAt?: number }
  const rows = new Map<string, Row>()
  const released: string[] = []
  const notes: { sessionId: string; text: string }[] = []
  const journalFor = (sessionId: string) => ({
    reads: { submission: async (id: string) => rows.get(id) },
    resolveDispatch: async (input: { clientMessageId: string; state: string }) => {
      const row = rows.get(input.clientMessageId)
      // Accepted and rejected are final, as in the journal reducer.
      if (row && row.dispatchState !== 'accepted' && row.dispatchState !== 'rejected') {
        row.dispatchState = input.state
      }
      return null
    },
    appendItem: async (_attribution: unknown, body: { text: string }) => {
      notes.push({ sessionId, text: body.text })
    },
    write: async (command: { kind: string }) => {
      if (command.kind === 'queue-resume') {
        released.push(sessionId)
      }
    }
  })
  const submission = (clientMessageId: string) => ({
    value: { clientMessageId, submission: rows.get(clientMessageId) }
  })
  const host = {
    sessions: new Map(['fast', 'stuck'].map((id) => [id, { journal: journalFor(id) }])),
    conversationFence: () => 1,
    send: async ({ envelope }: { envelope: { clientOperationId: string } }) => {
      const id = envelope.clientOperationId
      rows.set(id, { clientMessageId: id, dispatchState: 'pending', handedOverAt: 1 })
      return { ok: true, ...submission(id) }
    },
    awaitSendHandedOver: async (_sessionId: string, id: string) => submission(id),
    awaitSendSettlement: async (sessionId: string, id: string) => {
      if (sessionId === 'stuck') {
        // Never answers, like an agent stuck retrying its API.
        await new Promise(() => {})
      }
      rows.get(id)!.dispatchState = 'accepted'
      return submission(id)
    },
    awaitSendDispatched: async () => undefined,
    logger,
    now: () => 0
  }
  const answers = createRestartAnswers()
  for (const sessionId of ['fast', 'stuck']) {
    const started = await startStructuredAgentSessionContinuation(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an in-memory journal with only the reads and writes a continuation makes.
      continuationDeps(host as unknown as Parameters<typeof continuationDeps>[0], async () => true),
      sessionId,
      {},
      `continue-${sessionId}`
    )
    if (!('verdict' in started)) {
      throw new Error('expected a handed-over continuation')
    }
    answers.handedOver(sessionId, started.verdict(), started.giveUp)
  }
  await vi.advanceTimersByTimeAsync(0)
  const { settled } = await answers.settle(
    {
      operationId: 'op',
      outcomes: ['fast', 'stuck'].map((sessionId) => ({ sessionId, outcome: 'resumed' as const })),
      candidates: [],
      markers: new Map()
    },
    { settle: vi.fn(async () => []) },
    logger
  )
  await vi.advanceTimersByTimeAsync(150_000)
  await settled

  // Before: the stuck chat stayed "Sending…" and its queued messages stayed held behind it.
  expect(rows.get('continue-stuck')!.dispatchState).toBe('unknown')
  expect(released.toSorted()).toEqual(['fast', 'stuck'])
  expect(notes).toEqual([
    { sessionId: 'fast', text: AGENT_SESSION_RESTART_CONTINUATION_NOTE },
    { sessionId: 'stuck', text: AGENT_SESSION_RESTART_CONTINUATION_UNCONFIRMED_NOTE }
  ])
})
