import { afterEach, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import Database from '../../sqlite/sync-database'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlReducer } from './journal-sql-reducer'
import { journalSqlProjectionSchema } from './journal-sql-projection-schema'
import { readJournalSqlContinuationContext } from './journal-sql-continuation-context'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function send(id: string, submittedAt: number, acceptedSequence?: number): AgentJournalSubmission {
  return {
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: id,
    dispatchState: acceptedSequence === undefined ? 'pending' : 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt,
    resolvedAt: null,
    ...(acceptedSequence === undefined ? {} : { acceptedSequence })
  }
}

function item(
  id: string,
  sequence: number,
  body: AgentJournalRenderItem['body'] = { kind: 'message', role: 'user', blocks: [] }
): AgentJournalRenderItem {
  return { itemId: id, sequence, observedAt: 1, revision: 0, body }
}

it('exports only visible rows and sends after the newest clear, across query pages', () => {
  const db = new Database(':memory:')
  databases.push(db)
  db.exec(journalSqlProjectionSchema())
  const scope = () => new JournalSqlScope(db, 'session', 'generation')
  const reducer = new JournalSqlReducer(scope(), 'epoch')
  const { state } = reducer
  const prompt = (id: string, sequence: number, submission: AgentJournalSubmission) => {
    state.submissions.set(id, submission)
    state.items.set(agentJournalSubmissionKey(id), item(agentJournalSubmissionKey(id), sequence))
  }
  prompt('before', 1, send('before', 1, 1))
  prompt('pending', 2, send('pending', 2))
  state.items.set(
    'clear',
    item('clear', 3, {
      kind: 'status',
      text: 'Cleared',
      contextClear: { operationId: 'clear', afterFence: 1, clearedAt: 1 }
    })
  )
  const tail = Array.from({ length: 300 }, (_, index) => `tail-${index}`)
  tail.forEach((id, index) => state.items.set(id, item(id, 4 + index)))
  prompt('after', 400, send('after', 3, 400))
  prompt('rejected', 401, send('rejected', 4, 401))
  state.inputs.rejections.set('rejected', send('rejected', 4, 401))
  reducer.flush()

  const cleared = readJournalSqlContinuationContext(scope())
  expect(cleared.items.map((row) => row.itemId)).toEqual([...tail, 'orca:after'])
  expect(cleared.submissions.map((row) => row.clientMessageId)).toEqual(['after', 'rejected'])

  state.items.delete('clear')
  reducer.flush()
  const whole = readJournalSqlContinuationContext(scope())
  expect(whole.items.map((row) => row.itemId)).toEqual([
    'orca:before',
    'orca:pending',
    ...tail,
    'orca:after'
  ])
  expect(whole.submissions.map((row) => row.clientMessageId)).toEqual([
    'before',
    'pending',
    'after',
    'rejected'
  ])
})
