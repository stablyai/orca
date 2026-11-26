import { expect, it } from 'vitest'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { ActingSender } from './bot-recipient'
import { answersRequest } from './bot-request-record'

const purposes: Record<string, string> = { msg_status: 'status', msg_question: 'question' }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: answersRequest reads only getBotRequest.
const db = {
  getBotRequest: (id: string) =>
    purposes[id] ? { record: JSON.stringify({ purpose: purposes[id] }) } : undefined
} as unknown as OrchestrationDb
const turnOf = (requestIds: string[]) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: answersRequest reads only requestIds.
  ({
    worker: null,
    turn: { actingOnRequestId: requestIds[0] ?? null, requestIds }
  }) as unknown as Pick<ActingSender, 'worker' | 'turn'>

it('answers the first request that wants an answer, past status mail the turn also took', () => {
  expect(answersRequest(db, turnOf(['msg_status', 'msg_question']))).toEqual({
    answersRequest: 'msg_question'
  })
  expect(answersRequest(db, turnOf(['msg_status']))).toEqual({})
})
