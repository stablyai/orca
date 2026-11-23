import { expect, it } from 'vitest'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { ActingSender } from './bot-recipient'
import { answersRequest, botRequestActsFor } from './bot-request-record'

const OWNER = [{ kind: 'owner' }]
const records: Record<string, object> = {
  msg_status: { purpose: 'status' },
  msg_question: { purpose: 'question' },
  // An earlier version's record of a request pulled from a paired server, and a direct one.
  msg_from_server: {
    purpose: 'question',
    fromPairedServer: 'Build Box',
    askers: OWNER,
    askedBy: OWNER
  },
  msg_direct: {
    purpose: 'question',
    fromPairedComputer: 'Build Box',
    askers: OWNER,
    askedBy: OWNER
  },
  // Recorded alike since both directions share one field: told apart by the conversation filed under.
  msg_pulled: {
    purpose: 'question',
    fromPairedComputer: 'Build Box',
    askers: OWNER,
    askedBy: OWNER
  }
}
// A conversation a server this computer dials opened names its environment; one a computer that
// dials here opened names none.
const conversations: Record<string, { role: string; environment_id: string | null }> = {
  msg_direct: { role: 'peer', environment_id: null },
  msg_pulled: { role: 'peer', environment_id: 'env_s' }
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these reads use only the three lookups below.
const db = {
  getBotRequest: (id: string) =>
    records[id] ? { record: JSON.stringify(records[id]) } : undefined,
  getPeerMailMessage: (id: string) => (conversations[id] ? { conversation_id: id } : undefined),
  getPeerMailConversation: (id: string) => conversations[id]
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

it('reads a request an earlier version recorded from a paired server as no one here, never the owner', () => {
  expect(botRequestActsFor(db, 'msg_from_server')).toEqual({
    askers: [{ kind: 'unknown' }],
    askedBy: [{ kind: 'unknown' }]
  })
  expect(botRequestActsFor(db, 'msg_pulled')).toEqual({
    askers: [{ kind: 'unknown' }],
    askedBy: [{ kind: 'unknown' }]
  })
  expect(botRequestActsFor(db, 'msg_direct')).toEqual({ askers: OWNER, askedBy: OWNER })
})
