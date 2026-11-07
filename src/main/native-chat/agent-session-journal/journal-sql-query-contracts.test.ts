import { afterEach, expect, it } from 'vitest'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalRenderItem,
  type AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import Database from '../../sqlite/sync-database'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlReducer } from './journal-sql-reducer'
import { journalSqlProjectionSchema } from './journal-sql-projection-schema'
import { journalInputOrder } from './input-order/journal-input-order'
import { encodeJournalOutcomes, journalOutcomeScalars } from './outcomes/journal-outcome-codec'
import { journalOutcomeScalarJson } from './journal-outcome-scalars'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})
function fixture() {
  const db = new Database(':memory:')
  databases.push(db)
  db.exec(journalSqlProjectionSchema())
  return () => {
    const scope = new JournalSqlScope(db, 'session', 'generation')
    return { scope, command: new JournalSqlReducer(scope, 'epoch') }
  }
}
function send(id: string, at = 1): AgentJournalSubmission {
  return {
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: at,
    resolvedAt: null
  }
}
function item(
  id: string,
  sequence: number,
  body: AgentJournalRenderItem['body'] = { kind: 'message', role: 'user', blocks: [] }
): AgentJournalRenderItem {
  return { itemId: id, sequence, observedAt: 1, revision: 0, body }
}

it('uses separate echo eligibility before and after a clear, counts skipped accepted rows, and preserves equal-time order', () => {
  const command = fixture()
  let c = command()
  for (const id of ['missing-acceptance', 'before-clear', 'after-clear', 'equal-time']) {
    c.command.state.submissions.set(id, {
      ...send(id),
      ...(id === 'missing-acceptance' ? {} : { acceptedSequence: id === 'before-clear' ? 2 : 9 })
    })
    c.command.state.items.set(agentJournalSubmissionKey(id), item(agentJournalSubmissionKey(id), 2))
  }
  c.command.flush()
  c = command()
  const q = c.command.state.queries
  expect(q.echoClaimant(c.command.state, 'fp', false)).toBe(
    agentJournalSubmissionKey('missing-acceptance')
  )
  c.command.state.items.set(
    'clear',
    item('clear', 5, {
      kind: 'status',
      text: 'Cleared',
      contextClear: { operationId: 'clear', afterFence: 1, clearedAt: 1 }
    })
  )
  c.command.flush()
  expect(q.echoClaimant(c.command.state, 'fp', false)).toBe(
    agentJournalSubmissionKey('after-clear')
  )
  c.command.state.inputs.echoes.add(agentJournalSubmissionKey('after-clear'))
  c.command.flush()
  expect(q.echoClaimant(c.command.state, 'fp', false)).toBe(agentJournalSubmissionKey('equal-time'))
  c.command.state.items.delete(agentJournalSubmissionKey('equal-time'))
  c.command.flush()
  expect(q.echoClaimant(c.command.state, 'fp', false)).toBeNull()
})

it('keeps fence candidates including ended sends, alias insertion order, strict rewind cuts and turn tie order', () => {
  const command = fixture()
  let c = command()
  const state = c.command.state
  state.submissions.set('ended', send('ended'))
  state.inputs.candidates.set('ended', state.submissions.get('ended')!)
  state.items.set(agentJournalSubmissionKey('ended'), item(agentJournalSubmissionKey('ended'), 1))
  state.inputs.candidates.set('other', { ...send('other'), fence: 2 })
  state.inputs.ended.add('ended')
  state.inputs.handovers.set('other', {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'epoch',
    seq: 2,
    ts: 1,
    fence: 1,
    kind: 'dispatch',
    clientMessageId: 'other',
    state: 'pending',
    providerItemId: null,
    reason: null
  })
  state.aliases.set('provider-2', 'native')
  state.aliases.set('provider-1', 'native')
  state.aliases.set('foreign', 'another')
  state.items.set('tail-first', item('tail-first', 9))
  state.items.set('floor', item('floor', 5))
  state.items.set('tail-second', item('tail-second', 8))
  state.items.set('turn-a', item('turn-a', 2, { kind: 'turn', turnId: 'a', state: 'running' }))
  state.items.set('turn-b', {
    ...item('turn-b', 2, { kind: 'turn', turnId: 'b', state: 'completed' }),
    sequenceIndex: -1
  })
  c.command.flush()
  c = command()
  const q = c.command.state.queries
  expect(q.candidatesForFence(c.command.state, 1).map((v) => v.clientMessageId)).toEqual([
    'ended',
    'other'
  ])
  expect(
    [...q.candidatesForHandoverFence(c.command.state, 1)].map((v) => v.clientMessageId)
  ).toEqual(['other'])
  expect([...q.aliasesForSubmission(c.command.state, 'native')]).toEqual([
    'provider-2',
    'provider-1'
  ])
  expect([...q.itemsAfterSequence(c.command.state, 5)].map((v) => v.itemId)).toEqual([
    'tail-first',
    'tail-second'
  ])
  expect(q.newestTurnBySequence(c.command.state)).toEqual({ turnId: 'b', state: 'completed' })
  expect(q.latestItemForTurn(c.command.state, 'a')?.itemId).toBe('turn-a')
  c.command.state.items.set(
    'orca:hidden-turn',
    item('orca:hidden-turn', 20, { kind: 'turn', turnId: 'a', state: 'completed' })
  )
  c.command.state.inputs.rejections.set('hidden-turn', send('hidden-turn'))
  expect(q.latestItemForTurn(c.command.state, 'a')?.itemId).toBe('turn-a')
  c.command.state.inputs.rejections.delete('hidden-turn')
  expect(q.latestItemForTurn(c.command.state, 'a')?.itemId).toBe('orca:hidden-turn')
  c.command.state.items.delete('orca:hidden-turn')
  const sourceOnly = command()
  sourceOnly.command.state.submissions.get('ended')!.fence = 3
  sourceOnly.command.flush()
  const afterAlias = command()
  expect(afterAlias.command.state.submissions.get('ended')?.fence).toBe(3)
  expect(
    afterAlias.command.state.queries
      .candidatesForFence(afterAlias.command.state, 3)
      .map((v) => v.clientMessageId)
  ).toEqual(['ended'])
  const aliasOnly = command()
  aliasOnly.command.state.inputs.candidates.get('ended')!.dispatchState = 'accepted'
  aliasOnly.command.flush()
  const accepted = command()
  expect(accepted.command.state.queries.latestAcceptedUnopened(accepted.command.state)).toBe(true)
  c.command.state.submissions.set('opener', { ...send('opener'), dispatchState: 'accepted' })
  c.command.state.items.set(
    agentJournalSubmissionKey('opener'),
    item(agentJournalSubmissionKey('opener'), 10)
  )
  expect(q.latestAcceptedUnopened(c.command.state)).toBe(true)
  c.command.state.aliases.set('provider-opener', agentJournalSubmissionKey('opener'))
  c.command.state.items.set(
    'opened',
    item('opened', 11, {
      kind: 'turn',
      turnId: 'opened',
      state: 'running',
      userItemId: 'provider-opener'
    })
  )
  expect(q.latestAcceptedUnopened(c.command.state)).toBe(false)
})

it('saves nothing for an unchanged clear on a later command and preserves lifted clear bytes', () => {
  const command = fixture()
  let c = command()
  c.command.state.queuePauseMarks.cleared = {
    operationId: 'clear',
    messageIds: Array.from({ length: 1000 }, (_, i) => `card-${i}`),
    sequence: 5
  }
  journalInputOrder(c.command.state).cards.ensure(c.command.state)
  c.command.flush()
  const before = journalOutcomeScalarJson(journalOutcomeScalars(c.command.state).queuePauseMarks)
  c = command()
  const previous = journalOutcomeScalars(c.command.state)
  const marks = c.command.state.queuePauseMarks
  const unchanged = marks.cleared
  marks.cleared = unchanged
  journalInputOrder(c.command.state).cards.ensure(c.command.state)
  expect(
    encodeJournalOutcomes(c.command.state, [], previous, c.command.context.untracked).values
  ).toEqual([])
  const after = journalOutcomeScalarJson(journalOutcomeScalars(c.command.state).queuePauseMarks)
  expect(after).toBe(before)
  c.command.state.queuePauseMarks.cleared!.lifted = true
  c.command.flush()
  c = command()
  expect(c.command.state.queuePauseMarks.cleared?.messageIds.length).toBe(1000)
  expect(c.command.state.queuePauseMarks.cleared?.lifted).toBe(true)
})
