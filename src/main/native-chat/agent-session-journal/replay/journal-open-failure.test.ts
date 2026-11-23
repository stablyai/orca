import { expect, it } from 'vitest'
import { journalOpenRefusal } from './journal-open-failure'
import { journalSqlFailure, restoreJournalSqlFailure } from '../journal-sql-failure'
import { JournalSqlBatchError } from '../journal-sql-batch'
import { agentSessionReadHistoryRefusalParts } from '../../../../shared/agent-session/failures/agent-session-refusal-notice'

const sqliteError = (message: string, errcode: number) =>
  Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode })

// What an open receives once the writer's worker rejected a batch.
const fromWriter = (cause: Error) =>
  restoreJournalSqlFailure(journalSqlFailure(new JournalSqlBatchError('rolled-back', cause)))

it('an open the disk refused asks for space, and damage still reads as damage', () => {
  expect(journalOpenRefusal(fromWriter(sqliteError('database or disk is full', 13)))).toEqual(
    expect.objectContaining({
      code: 'agent_session_journal_unreadable',
      details: { reason: 'journalStorageFull' },
      message:
        'The disk on the computer running this chat is full. Free up space on that disk, then try again.'
    })
  )
  expect(
    journalOpenRefusal(Object.assign(new Error('write failed'), { cause: { code: 'ENOSPC' } }))
      .details
  ).toEqual({ reason: 'journalStorageFull' })
  expect(journalOpenRefusal(sqliteError('database disk image is malformed', 11)).details).toEqual({
    reason: 'journalCorrupt'
  })
  expect(journalOpenRefusal(new Error('busy')).details).toEqual({ reason: 'journalUnavailable' })
  // Desktop shows a Retry beside history notices; the step to free space must stay with it.
  const refusal = journalOpenRefusal(fromWriter(sqliteError('database or disk is full', 13)))
  expect(
    agentSessionReadHistoryRefusalParts(refusal.code, refusal.details, { retryControl: true })
  ).toContain('freeDiskSpace')
})
