import { expect, it, vi } from 'vitest'
import { createRestartAnswers } from './structured-agent-session-restart-answers'
import type { StructuredAgentSessionContinuationOutcome } from './structured-agent-session-restart-continuation'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'

const logger: StructuredAgentSessionLogger = { warn: vi.fn(), error: vi.fn() }

it('settles answered chats at once and a chat whose agent answers late on its own', async () => {
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
  answers.handedOver('stuck', late.promise)
  await Promise.resolve()

  const waiting = await answers.settle(
    {
      operationId: 'op',
      outcomes: [
        { sessionId: 'fast', outcome: 'resumed' },
        { sessionId: 'stuck', outcome: 'resumed' }
      ],
      candidates: [],
      markers: new Map()
    },
    failures,
    logger
  )

  expect([...waiting]).toEqual(['stuck'])
  expect(settled).toEqual([{ ids: ['fast'], last: false, failure: [null] }])

  late.resolve({
    sessionId: 'stuck',
    outcome: 'refused',
    reason: 'agent_session_dispatch_rejected'
  })
  await vi.waitFor(() => expect(settled).toHaveLength(3))
  expect(settled.slice(1)).toEqual([
    { ids: ['stuck'], last: false, failure: ['refused'] },
    { ids: [], last: true, failure: [] }
  ])
})
