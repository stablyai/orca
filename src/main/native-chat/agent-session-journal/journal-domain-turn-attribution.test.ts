import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { runJournalTransaction } from './database/journal-database'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import { insertJournalDomainImportedSubmission } from './journal-domain-import-submissions'
import { readJournalDomainTurnAttribution } from './journal-domain-turn-attribution'
import { JournalSqlScope } from './journal-sql-scope'

const target = { sessionId: 'chat', epoch: 'epoch' }
const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

const user = (text: string, deliveryId?: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }],
  ...(deliveryId
    ? {
        connectorDelivery: {
          account: 'slack-bot',
          conversation: { source: 'slack', externalId: 'C1' },
          deliveryId
        }
      }
    : {})
})

function chat() {
  const db = new Database(':memory:')
  databases.push(db)
  migrateJournalDomainSchema(db)
  db.prepare(
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('workspace',?,?,900,1)`
  ).run(target.sessionId, target.epoch)
  const item = (itemId: string, sequence: number, body: AgentJournalItemBody) =>
    runJournalTransaction(db, () =>
      writeJournalDomainCurrentItem(db, target, {
        item: { itemId, revision: 1, sequence, observedAt: sequence, body },
        ordinal: sequence,
        hidden: false,
        ownerFence: 1
      })
    )
  const alias = (providerItemId: string, itemId: string) =>
    db
      .prepare(
        'INSERT INTO journal_item_aliases(session_id,epoch,provider_item_id,item_id) VALUES(?,?,?,?)'
      )
      .run(target.sessionId, target.epoch, providerItemId, itemId)
  /** A send whose message item is `orca:<id>`, answered in `turnItemId` by `via`. */
  const send = (
    id: string,
    sequence: number,
    body: AgentJournalMessageItem,
    answered: { turnItemId: string; via: 'start' | 'steer' }
  ) => {
    item(`orca:${id}`, sequence, body)
    const submission: AgentJournalSubmission = {
      clientMessageId: id,
      fence: 1,
      payloadFingerprint: id,
      dispatchState: 'accepted',
      providerItemId: null,
      reason: null,
      resolvedAt: sequence,
      submittedAt: sequence,
      acceptedSequence: sequence,
      answeredInTurn: answered
    }
    insertJournalDomainImportedSubmission(db, target, {
      submission,
      sequence,
      index: 0,
      ordinal: sequence,
      candidate: false,
      admittedPersonal: true,
      echoObserved: false,
      admission: {
        body,
        providerHandle: null,
        fence: 1,
        scope: null,
        familyId: null,
        origin: 'client',
        sourceKind: 'user',
        options: null
      },
      handover: null,
      handoverPlace: null,
      carries: [],
      rejection: null,
      presentationMember: false,
      normalizedHandOff: false
    })
  }
  const read = (turnId: string, through = 900) =>
    readJournalDomainTurnAttribution(
      new JournalSqlScope(db, target.sessionId, target.epoch),
      turnId,
      through
    )
  return { item, alias, send, read }
}

const deliveryIds = (stamps: { deliveryId: string }[] | null) =>
  stamps?.map((stamp) => stamp.deliveryId) ?? null

it("stamps a turn with its opener's delivery and each send steered into it, not another turn's", () => {
  const f = chat()
  f.send('other-open', 1, user('earlier', 'delivery-other-open'), {
    turnItemId: 'turn-0',
    via: 'start'
  })
  f.item('turn-0', 2, { kind: 'turn', turnId: 'provider-turn-0', state: 'completed' })
  f.item('orca:open', 10, user('open', 'delivery-open'))
  f.alias('provider:open', 'orca:open')
  f.item('turn-1', 11, {
    kind: 'turn',
    turnId: 'provider-turn-1',
    state: 'running',
    userItemId: 'provider:open'
  })
  f.send('steered', 12, user('also this', 'delivery-steered'), {
    turnItemId: 'turn-1',
    via: 'steer'
  })
  f.send('elsewhere', 13, user('not this', 'delivery-elsewhere'), {
    turnItemId: 'turn-0',
    via: 'steer'
  })

  const attribution = f.read('provider-turn-1')
  expect(attribution.turnItemId).toBe('turn-1')
  expect(attribution.opener?.itemId).toBe('orca:open')
  expect(deliveryIds(attribution.stamps)).toEqual(['delivery-open', 'delivery-steered'])
})

it('proves nothing for a turn the journal does not hold', () => {
  const f = chat()
  f.item('orca:open', 10, user('open', 'delivery-open'))

  expect(f.read('provider-turn-missing')).toMatchObject({
    turnItemId: null,
    opener: null,
    stamps: null
  })
})

it('stamps the opener and excludes steers newer than the read position', () => {
  const f = chat()
  f.item('orca:open', 10, user('open', 'delivery-open'))
  f.item('turn-1', 11, {
    kind: 'turn',
    turnId: 'provider-turn-1',
    state: 'completed',
    userItemId: 'orca:open'
  })
  f.send('late', 20, user('after the end', 'delivery-late'), {
    turnItemId: 'turn-1',
    via: 'steer'
  })

  const ended = f.read('provider-turn-1', 12)
  expect(ended.opener?.itemId).toBe('orca:open')
  expect(deliveryIds(ended.stamps)).toEqual(['delivery-open'])
  expect(deliveryIds(f.read('provider-turn-1', 20).stamps)).toEqual([
    'delivery-open',
    'delivery-late'
  ])
})
