import { expect, it } from 'vitest'
import { messageFixture, target } from '../journal-sql-message.test-fixture'
import { insertJournalDomainItemRows } from '../journal-domain-import-rows'
import { readJournalSqlPoint } from '../journal-sql-point-read'
import { runJournalTransaction } from './journal-database'

it('does not import the native authority of a copied receipt body', async () => {
  const { db, commitCommands } = messageFixture()
  try {
    await commitCommands([
      {
        target,
        operation: {
          kind: 'steps',
          steps: [
            {
              kind: 'creation-fact',
              epoch: 'epoch',
              reservedBytes: 4096,
              identity: { provider: 'orca', clientMessageId: 'receipt' },
              body: {
                kind: 'automation-saved',
                change: 'created',
                automation: {
                  id: 'a',
                  name: 'Original',
                  enabled: true,
                  nextRunAt: 0,
                  updatedAt: 10,
                  dtstart: 0,
                  rrule: '0 * * * *',
                  workspaceId: null
                }
              },
              options: { fence: 1, turnScope: { kind: 'thread' } }
            }
          ]
        }
      }
    ])
    const native = readJournalSqlPoint(db, {
      sessionId: 'chat',
      operation: { kind: 'native-automation-receipt', itemId: 'orca:receipt' }
    })
    if (native.kind !== 'native-automation-receipt' || !native.item) {
      throw new Error('Missing native receipt')
    }
    const copied = JSON.parse(JSON.stringify(native.item))
    db.prepare(`INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence)
      VALUES('workspace','copied','copy',10,1)`).run()
    runJournalTransaction(db, () =>
      insertJournalDomainItemRows(db, { sessionId: 'copied', epoch: 'copy' }, [
        {
          ordinal: 1,
          ownerFence: 0,
          executionOwner: null,
          hidden: false,
          item: copied,
          turnItemId: null,
          originalStopNoteJson: null,
          queueCommandTurn: false,
          queueFailedOutcome: false,
          queueFailedAt: 0,
          queueFailureWitnessedThrough: 0,
          queueFailureReportTurnItemId: null
        }
      ])
    )
    expect(
      readJournalSqlPoint(db, {
        sessionId: 'copied',
        operation: { kind: 'native-automation-receipt', itemId: 'orca:receipt' }
      })
    ).toEqual({ kind: 'native-automation-receipt', item: null })
  } finally {
    db.close()
  }
})
