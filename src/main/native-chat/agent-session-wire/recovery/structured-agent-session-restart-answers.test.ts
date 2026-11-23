import { afterEach, expect, it, vi } from 'vitest'
import { createRestartAnswers } from './structured-agent-session-restart-answers'
import type { StructuredAgentSessionContinuationOutcome } from './structured-agent-session-restart-continuation'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'

const logger: StructuredAgentSessionLogger = { warn: vi.fn(), error: vi.fn() }

afterEach(() => vi.useRealTimers())

it('returns before late answers, then settles them in one pass without dropping an unanswered record', async () => {
  vi.useFakeTimers()
  const settled: { ids: string[]; last: boolean; failure: (string | null)[] }[] = []
  const failures = {
    settle: vi.fn(async (_op, outcomes, action, last = true) => {
      const ids = outcomes.map((outcome: { sessionId: string }) => outcome.sessionId)
      settled.push({ ids, last, failure: ids.map((id: string) => action.failureAfterResume(id)) })
    })
  }
  const answers = createRestartAnswers()
  const late = Promise.withResolvers<StructuredAgentSessionContinuationOutcome>()
  answers.handedOver('fast', Promise.resolve({ sessionId: 'fast', outcome: 'continued' }))
  answers.handedOver('refused', late.promise)
  // Never answers, like an agent stuck retrying its API.
  answers.handedOver('stuck', new Promise(() => {}))
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
    { ids: ['refused', 'stuck'], last: true, failure: ['refused', 'unconfirmed'] }
  ])
})
