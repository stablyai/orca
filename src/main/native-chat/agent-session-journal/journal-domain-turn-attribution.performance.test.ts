import { afterEach, expect, it, vi } from 'vitest'
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
import { readJournalDomainOperationWindow } from './journal-domain-operation-window'
import { readJournalDomainTurnAttribution } from './journal-domain-turn-attribution'
import { JournalSqlScope } from './journal-sql-scope'

// Perf contract for STA-16280 and STA-16396: a turn end's reads (its attribution, and the operation
// window the replied, mirrored and failed ends read) examine only the ended turn's rows and the turn
// before it, never the chat's send history.

const target = { sessionId: 'chat', epoch: 'epoch' }
const databases: Database.Database[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) {
    db.close()
  }
})

const user = (text: string, deliveryId: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }],
  connectorDelivery: {
    account: 'slack-bot',
    conversation: { source: 'slack', externalId: 'C1' },
    deliveryId
  }
})

// Fixed past every earlier send, so the target rows are byte-identical at any N.
const TARGET_SEQUENCE = 100_000
/** The turn end's read position, past every row the chat holds. */
const END = TARGET_SEQUENCE + 100

/** `earlier` accepted sends, each opening its own finished turn, then the target turn. */
function chat(earlier: number) {
  const db = new Database(':memory:')
  databases.push(db)
  migrateJournalDomainSchema(db)
  db.prepare(
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('workspace',?,?,?,1)`
  ).run(target.sessionId, target.epoch, TARGET_SEQUENCE + 10)
  const item = (itemId: string, sequence: number, body: AgentJournalItemBody) =>
    writeJournalDomainCurrentItem(db, target, {
      item: { itemId, revision: 1, sequence, observedAt: sequence, body },
      ordinal: sequence,
      hidden: false,
      ownerFence: 1
    })
  const send = (
    id: string,
    sequence: number,
    answered: { turnItemId: string; via: 'start' | 'steer' }
  ) => {
    const body = user(id, `delivery-${id}`)
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
  runJournalTransaction(db, () => {
    for (let index = 0; index < earlier; index++) {
      const sequence = index * 2 + 1
      send(`earlier-${index}`, sequence, { turnItemId: `turn-${index}`, via: 'start' })
      item(`turn-${index}`, sequence + 1, {
        kind: 'turn',
        turnId: `provider-turn-${index}`,
        state: 'completed',
        userItemId: `orca:earlier-${index}`
      })
    }
    const base = TARGET_SEQUENCE
    // The turn the window's margin holds, at fixed positions so its rows are the same at any N.
    send('previous', base - 10, { turnItemId: 'turn-previous', via: 'start' })
    item('turn-previous', base - 9, {
      kind: 'turn',
      turnId: 'provider-turn-previous',
      state: 'completed',
      userItemId: 'orca:previous'
    })
    send('open', base, { turnItemId: 'turn-target', via: 'start' })
    item('turn-target', base + 1, {
      kind: 'turn',
      turnId: 'provider-turn-target',
      state: 'running',
      userItemId: 'orca:open'
    })
    send('steered', base + 2, { turnItemId: 'turn-target', via: 'steer' })
  })
  return db
}

function attributionWork(earlier: number) {
  const scope = new JournalSqlScope(chat(earlier), target.sessionId, target.epoch)
  const attribution = readJournalDomainTurnAttribution(scope, 'provider-turn-target', END)
  expect(attribution.stamps?.map((stamp) => stamp.deliveryId)).toEqual([
    'delivery-open',
    'delivery-steered'
  ])
  return { ...scope.work }
}

it("reads the same rows for a turn's attribution whether the chat holds 200 or 2000 earlier sends", () => {
  const small = attributionWork(200)
  const large = attributionWork(2000)
  expect(large).toEqual(small)
  // The one steered send's attempt row.
  expect(small.rows).toBe(1)
})

it('finds the steered sends through their index, without a scan or sort', () => {
  const db = chat(200)
  const prepare = db.prepare.bind(db)
  const steered: string[] = []
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    if (sql.includes('journal_submission_attempts') && !sql.startsWith('EXPLAIN')) {
      steered.push(sql)
    }
    return prepare(sql)
  })
  readJournalDomainTurnAttribution(
    new JournalSqlScope(db, target.sessionId, target.epoch),
    'provider-turn-target',
    END
  )
  expect(steered).toHaveLength(1)
  const plan = prepare(`EXPLAIN QUERY PLAN ${steered[0]}`)
    .all(target.sessionId, target.epoch, 'turn-target')
    .map((step) => String(step.detail))
  expect(plan.join('\n')).toContain('USING INDEX journal_submission_steer')
  expect(plan.join('\n')).not.toMatch(/TEMP B-TREE|^SCAN journal_submission_attempts$/m)
})

/** The operation window a turn end reads (endedTurn), with every plan that touches a send. */
function windowWork(earlier: number) {
  const db = chat(earlier)
  const prepare = db.prepare.bind(db)
  const plans: string[] = []
  vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql)
    if (!sql.includes('journal_submission_attempts') || sql.startsWith('EXPLAIN')) {
      return statement
    }
    return new Proxy(statement, {
      get: (statement, key) => {
        const value = Reflect.get(statement, key, statement)
        if (typeof value !== 'function') {
          return value
        }
        return (...params: never[]) => {
          if (key === 'all' || key === 'get') {
            plans.push(
              prepare(`EXPLAIN QUERY PLAN ${sql}`)
                .all(...params)
                .map((step) => String(step.detail))
                .join('\n')
            )
          }
          return value.apply(statement, params)
        }
      }
    })
  })
  const scope = new JournalSqlScope(db, target.sessionId, target.epoch)
  const { snapshot } = readJournalDomainOperationWindow(scope, {
    turnIds: ['provider-turn-target'],
    itemIds: ['provider-turn-target'],
    anchorsOnly: true,
    withoutToolOutput: true
  })
  expect(snapshot.items.map((item) => item.itemId)).toEqual([
    'orca:previous',
    'turn-previous',
    'orca:open',
    'turn-target',
    'orca:steered'
  ])
  expect(snapshot.submissions.map((send) => send.clientMessageId)).toEqual([
    'previous',
    'open',
    'steered'
  ])
  return { work: { ...scope.work }, plans }
}

it("reads the same rows for a turn end's operation window whether the chat holds 200 or 2000 earlier sends", () => {
  const small = windowWork(200)
  const large = windowWork(2000)
  expect(large.work).toEqual(small.work)
})

it("finds a turn end's sends through their indexes, never by reading every send", () => {
  const plans = windowWork(200).plans.join('\n')
  for (const index of [
    'journal_submission_item',
    'journal_submission_provider_item',
    'journal_submission_answered_turn',
    'journal_submission_queued_card',
    'journal_submission_head'
  ]) {
    expect(plans).toContain(`USING INDEX ${index}`)
  }
  expect(plans).not.toMatch(/^SCAN (journal_submission_attempts|send)\b/m)
})
