import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../../sqlite/sync-database'
import {
  fillJournalConnectorReplies,
  sentJournalConnectorReplies,
  recordJournalConnectorReplies
} from './journal-connector-replies'
import {
  readJournalConnectorReplies,
  readOwedJournalConnectorReplies
} from './journal-connector-replies-read'
import { ensureJournalConnectorRepliesSchema } from './journal-connector-replies-schema'
import { migrateJournalDomainSchema } from '../database/journal-domain-migrations'
import type { JournalOperationWindow } from '../journal-domain-operation-window'
import { readOperationWindowItems } from '../journal-operation-window-rows'
import { JournalSqlScope } from '../journal-sql-scope'
import {
  SlackAnswerPresentationSchema,
  SLACK_PRESENTATION_UNCONFIRMED,
  slackAnswerText
} from '../../../../shared/connectors/slack-answer-presentation'
import {
  journalSlackAnswerPresentation,
  prepareSlackAnswerPresentation,
  pruneSlackAnswerPresentations
} from './journal-slack-answer-presentation'

let dir = ''
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('reads a row an older build left as the older quiet rule, and records new rows as trailing', () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-reply-schema-'))
  const db = new Database(join(dir, 'journal.db'))
  // The table as a build before quiet_rule made it, with a pending row of its own.
  db.exec(`CREATE TABLE journal_connector_replies (account TEXT NOT NULL, delivery_id TEXT NOT NULL,
    source TEXT NOT NULL, external_id TEXT NOT NULL, session_id TEXT NOT NULL, epoch TEXT NOT NULL,
    message_id TEXT NOT NULL, queued INTEGER NOT NULL, outcome TEXT, answer_delivery_id TEXT,
    turn_item_id TEXT, prose TEXT, failure_json TEXT, links_json TEXT, filled_at INTEGER,
    sent_at INTEGER, PRIMARY KEY(account, delivery_id)) WITHOUT ROWID`)
  db.exec(`INSERT INTO journal_connector_replies
    (account,delivery_id,source,external_id,session_id,epoch,message_id,queued)
    VALUES('a','old','slack','slack:T1:C1:1.2','chat-1','e','m0',0)`)
  ensureJournalConnectorRepliesSchema(db)
  recordJournalConnectorReplies(db, { sessionId: 'chat-1', epoch: 'e' }, 'm1', false, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'fix it' }],
    connectorDelivery: {
      account: 'a',
      conversation: { source: 'slack', externalId: 'slack:T1:C1:1.2' },
      deliveryId: 'new'
    }
  })
  const rules = Object.fromEntries(
    readJournalConnectorReplies(db).map((row) => [row.deliveryId, row.quietRule ?? null])
  )
  db.close()
  expect(rules).toEqual({ old: null, new: 'trailing' })
})

it('binds preparation to a running root turn and keeps the first filled presentation after reopen', () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-reply-schema-'))
  const file = join(dir, 'journal.db')
  const db = new Database(file)
  migrateJournalDomainSchema(db)
  const turn = { sessionId: 'chat-1', epoch: 'e', turnItemId: 'turn-1' }
  db.exec(`INSERT INTO journal_items
    (session_id,epoch,item_id,ordinal,revision,sequence,sequence_index,owner_fence,kind,lifecycle_state,payload_json)
    VALUES('chat-1','e','turn-1',1,1,1,0,0,'turn','running','{}')`)
  const presentation = SlackAnswerPresentationSchema.parse({
    v: 1,
    text: 'Compile took longest.',
    visual: {
      kind: 'table',
      title: 'Build stages',
      source: 'Build report',
      columns: [{ label: 'Stage' }, { label: 'Time', unit: 's' }],
      rows: [
        ['Install', 14],
        ['Compile', 87]
      ]
    }
  })
  expect(prepareSlackAnswerPresentation(db, { ...turn, epoch: 'older' }, presentation)).toBe(false)
  expect(prepareSlackAnswerPresentation(db, turn, presentation, 1)).toBe(true)
  db.exec(`UPDATE journal_items SET lifecycle_state='completed' WHERE item_id='turn-1'`)
  expect(
    prepareSlackAnswerPresentation(db, turn, { ...presentation, text: 'A later answer.' })
  ).toBe(false)
  recordJournalConnectorReplies(db, turn, 'm1', false, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'What took the most time?' }],
    connectorDelivery: {
      account: 'a',
      deliveryId: 'd',
      conversation: { source: 'slack', externalId: 'slack:T1:C1:1.2' }
    }
  })
  const first = {
    account: 'a',
    deliveryId: 'd',
    answerDeliveryId: 'd',
    turnItemId: turn.turnItemId,
    outcome: 'answered' as const,
    prose: slackAnswerText(presentation),
    presentationTurn: turn
  }
  expect(fillJournalConnectorReplies(db, [first], 10)).toBe(1)
  expect(
    fillJournalConnectorReplies(
      db,
      [{ ...first, outcome: 'quiet', prose: undefined, presentationTurn: undefined }],
      11
    )
  ).toBe(0)
  // A prior build wrote the presentation but did not record preparation on the turn row.
  db.exec('ALTER TABLE journal_items DROP COLUMN slack_answer_prepared')
  db.close()

  const reopened = new Database(file)
  try {
    migrateJournalDomainSchema(reopened)
    const scope = new JournalSqlScope(reopened, turn.sessionId, turn.epoch)
    const readPrepared = () => {
      const answers: NonNullable<JournalOperationWindow['slackAnswers']> = []
      readOperationWindowItems(scope, 0, {}, null, answers)
      return answers
    }
    expect(readPrepared()).toEqual([['turn-1', presentation]])
    expect(journalSlackAnswerPresentation(reopened, turn)).toEqual(presentation)
    expect(readJournalConnectorReplies(reopened, 'chat-1')[0]?.fill?.presentation).toBeUndefined()
    expect(readOwedJournalConnectorReplies(reopened, 'a', null, 1, true)[0]?.fill).toEqual({
      outcome: 'answered',
      answerDeliveryId: 'd',
      turnItemId: 'turn-1',
      prose: SLACK_PRESENTATION_UNCONFIRMED,
      presentation,
      filledAt: 10
    })
    expect(pruneSlackAnswerPresentations(reopened, 100, 50)).toEqual({ deleted: 0, more: false })
    expect(journalSlackAnswerPresentation(reopened, turn)).toEqual(presentation)
    sentJournalConnectorReplies(reopened, [{ account: 'a', deliveryId: 'd' }], 101)
    recordJournalConnectorReplies(reopened, turn, 'unrelated', false, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'An unrelated pending request' }],
      connectorDelivery: {
        account: 'a',
        deliveryId: 'unrelated',
        conversation: { source: 'slack', externalId: 'slack:T1:C1:1.2' }
      }
    })
    expect(pruneSlackAnswerPresentations(reopened, 150, 50)).toEqual({ deleted: 1, more: false })
    expect(journalSlackAnswerPresentation(reopened, turn)).toBeUndefined()
    expect(readPrepared()).toEqual([['turn-1', null]])
    expect(
      fillJournalConnectorReplies(
        reopened,
        [{ ...first, deliveryId: 'unrelated', answerDeliveryId: 'unrelated' }],
        151
      )
    ).toBe(1)
    expect(readOwedJournalConnectorReplies(reopened, 'a', null, 1, true)[0]?.fill).toEqual({
      outcome: 'answered',
      answerDeliveryId: 'unrelated',
      turnItemId: 'turn-1',
      prose: SLACK_PRESENTATION_UNCONFIRMED,
      filledAt: 151
    })
  } finally {
    reopened.close()
  }
})
