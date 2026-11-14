import { afterEach, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { messageFixture, target } from './journal-sql-message.test-fixture'
import { readJournalDomainLifecycle } from './journal-sql-lifecycle-reads'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

it('reads prompt, accepted handovers and root sign-out from the current chat snapshot', () => {
  const { db, seedItem, seedSend } = messageFixture()
  databases.push(db)
  seedSend()
  const signedOut = {
    kind: 'status' as const,
    ...agentSessionFailureWords(agentSessionFailureFact('notSignedIn'), { surface: 'row' })
  }
  seedItem({
    itemId: 'command',
    revision: 1,
    sequence: 8,
    observedAt: 8,
    body: { kind: 'message', role: 'user', command: { name: 'compact' }, blocks: [] }
  })
  seedItem({
    itemId: 'child-prompt',
    revision: 1,
    sequence: 9,
    observedAt: 9,
    agentId: 'child',
    producerKind: 'agent',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'child' }] }
  })
  seedItem({
    itemId: 'removed',
    revision: 1,
    sequence: 10,
    observedAt: 10,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'removed' }] }
  })
  db.prepare('UPDATE journal_items SET hidden=1 WHERE item_id=?').run('removed')
  seedItem({
    itemId: 'turn',
    revision: 1,
    sequence: 11,
    observedAt: 11,
    body: { kind: 'turn', turnId: 'turn', state: 'completed', completedAt: 20 }
  })
  seedItem({ itemId: 'root-signout', revision: 1, sequence: 12, observedAt: 12, body: signedOut })
  db.prepare('UPDATE journal_items SET execution_owner=2 WHERE item_id=?').run('root-signout')
  seedItem({
    itemId: 'child-signout',
    revision: 1,
    sequence: 13,
    observedAt: 13,
    agentId: 'child',
    producerKind: 'agent',
    body: signedOut
  })
  db.prepare('UPDATE journal_items SET execution_owner=3 WHERE item_id=?').run('child-signout')

  db.exec('BEGIN')
  const read = (operation: Parameters<typeof readJournalDomainLifecycle>[2]) =>
    readJournalDomainLifecycle(db, target, operation)
  expect(read({ kind: 'latest-prompt' })).toEqual({ kind: 'latest-prompt', prompt: 'original' })
  const progress = read({ kind: 'restart-progress', cursor: { epoch: 'epoch', sequence: 0 } })
  expect(progress).toMatchObject({
    kind: 'restart-progress',
    progress: {
      epoch: 'epoch',
      acceptedInputs: [{ clientMessageId: 'send', dispatchState: 'unknown', acceptedSequence: 1 }]
    }
  })
  expect(read({ kind: 'restart-progress', cursor: { epoch: 'epoch', sequence: 1 } })).toEqual({
    kind: 'restart-progress',
    progress: { epoch: 'epoch', acceptedInputs: [] }
  })
  expect(
    read({ kind: 'outgrown-child', input: { fence: 2, nextClientMessageId: 'send' } })
  ).toEqual({
    kind: 'outgrown-child',
    child: {
      signedOut: true,
      newestTurnCompletedAt: 20,
      nextMessage: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'original' }] }
    }
  })
  expect(read({ kind: 'outgrown-child', input: { fence: 3 } })).toEqual({
    kind: 'outgrown-child',
    child: { signedOut: false, newestTurnCompletedAt: 20, nextMessage: null }
  })
  db.prepare(
    'UPDATE journal_submission_attempts SET dispatch_fence=4,signed_out=1 WHERE message_id=?'
  ).run('send')
  expect(read({ kind: 'outgrown-child', input: { fence: 4 } })).toEqual({
    kind: 'outgrown-child',
    child: { signedOut: true, newestTurnCompletedAt: 20, nextMessage: null }
  })
  db.exec('COMMIT')
})
