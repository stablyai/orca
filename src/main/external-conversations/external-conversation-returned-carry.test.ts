import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  agentSessionFailureFact,
  isSubmissionRejectionFact,
  type AgentSessionFailureKind
} from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { ensureAgentSessionAttachmentClaimTables } from '../native-chat/agent-session-attachments/agent-session-attachment-claims'
import Database from '../sqlite/sync-database'
import { migrateJournalDomainSchema } from '../native-chat/agent-session-journal/journal-domain-schema'
import { applyJournalDomainSubmission } from '../native-chat/agent-session-journal/journal-domain-submission-admission'
import { applyJournalDomainGenerationSettlement } from '../native-chat/agent-session-journal/journal-domain-generation-settlement'
import { readJournalDomainReturnedCards } from '../native-chat/agent-session-journal/journal-domain-queue-reads'
import { journalDomainQueueRow } from '../native-chat/agent-session-journal/journal-domain-queue-rows'
import {
  journalDomainCarriedCards,
  settleJournalDomainCarriedCards
} from '../native-chat/agent-session-journal/journal-domain-carried-cards'
import { readJournalConnectorReplies } from '../native-chat/agent-session-journal/connector-replies/journal-connector-replies-read'
import type { ConnectorMessageAsker } from '../../shared/connector-message-asker'
import { actsForOwner, OWNER_ACTS_FOR } from '../../shared/bots/bot-acts-for'
import { readBotActingTurn } from '../bots/bot-request-asker'
import { carriedFields, carriedMessages } from './external-conversation-returned-carry'

// The real journal writer: a Slack message whose start failed, then the conversation's next message.
const NOW = 1_800_000_000_000
const target = { sessionId: 'chat-1', epoch: 'e' }
const THREAD = { source: 'slack' as const, externalId: 'T1:C1:1.2:UBOT' }
const OTHER = { source: 'slack' as const, externalId: 'T1:C1:9.9:UBOT' }
const ACCOUNT = 'account-a'
let dir = ''
let db: Database
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-returned-carry-'))
  db = new Database(join(dir, 'journal.db'))
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence)
     VALUES('workspace','chat-1','e',10,1)`
  ).run()
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const inWriter = <T>(write: () => T): T => {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = write()
    db.exec('COMMIT')
    return value
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const asked = (
  deliveryId: string,
  text: string,
  conversation = THREAD,
  images: string[] = [],
  asker?: ConnectorMessageAsker
): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }, ...images.map((path) => ({ type: 'image-ref' as const, path }))],
  origin: 'connector',
  connectorConversation: conversation,
  connectorDelivery: { account: ACCOUNT, conversation, deliveryId },
  ...(asker ? { asker } : {})
})

/** A connector send as the seam admits it (a person's message the host relays). */
function admit(id: string, body: AgentJournalMessageItem, at = NOW): void {
  inWriter(() =>
    applyJournalDomainSubmission(
      db,
      dir,
      target,
      {
        kind: 'submission',
        input: {
          clientMessageId: id,
          body,
          payloadFingerprint: agentSessionSendBodyFingerprint('chat-1', body),
          fence: 1,
          handoverRecorded: true,
          origin: 'host',
          source: { kind: 'user' }
        }
      },
      {
        identity: {
          ...target,
          workspaceId: 'workspace',
          hostId: 'host',
          agent: 'claude',
          providerHandle: null
        }
      },
      at
    )
  )
}

function rejection(kind: AgentSessionFailureKind) {
  const fact = agentSessionFailureFact(kind)
  if (!isSubmissionRejectionFact(fact)) {
    throw new Error(`${kind} never rejects a message`)
  }
  return fact
}

/** Its agent's launch refused it, which keeps it as a returned card. */
function failedStart(
  id: string,
  body: AgentJournalMessageItem,
  kind: AgentSessionFailureKind = 'notSignedIn',
  at = NOW
): void {
  admit(id, body, at)
  refuseStart(id, kind, at)
}

function refuseStart(id: string, kind: AgentSessionFailureKind = 'notSignedIn', at = NOW): void {
  inWriter(() =>
    applyJournalDomainGenerationSettlement(
      db,
      target,
      {
        kind: 'start-failure-settle',
        input: {
          startKey: id,
          clientMessageId: id,
          fence: 1,
          ...agentSessionFailureWords(rejection(kind), { surface: 'rejection' })
        }
      },
      at
    )
  )
}

/** The next message of THREAD, as deliverToChat builds it and its admission settles it. */
function sendNext(
  id: string,
  text: string,
  at = NOW + 120_000,
  { images = [], asker }: { images?: string[]; asker?: ConnectorMessageAsker } = {}
) {
  const carried = carriedMessages(
    THREAD,
    readJournalDomainReturnedCards(db, target, at),
    ACCOUNT,
    at,
    images.length
  )
  const own = asked(id, text, THREAD, images, asker)
  const body: AgentJournalMessageItem = {
    ...own,
    blocks: [...carried.blocks, ...own.blocks],
    ...carriedFields(carried),
    connectorDelivery: { ...own.connectorDelivery!, carried: carried.deliveryIds }
  }
  return { carried, body, admit: () => admitCarrying(id, body, at) }
}

/** What send admission does with a carried message: re-check, settle, then admit it. */
function admitCarrying(id: string, body: AgentJournalMessageItem, at: number): boolean {
  const rows = inWriter(() => {
    const checked = journalDomainCarriedCards(db, target, body, at)
    if (checked) {
      settleJournalDomainCarriedCards(db, target, id, checked, { fence: 1, savedAt: at })
    }
    return checked
  })
  if (!rows) {
    return false
  }
  admit(id, body, at)
  return true
}

const returnedIds = () =>
  readJournalDomainReturnedCards(db, target, NOW + 300_000).map(({ card }) => card.messageId)

it('carries the failed root with its image ahead of the next message, once', () => {
  failedStart('root', asked('d-root', 'what is in this screenshot?', THREAD, ['/a/shot.png']))
  expect(returnedIds()).toEqual(['root'])

  const next = sendNext('next', 'it is signed in now')
  expect(next.body.blocks).toEqual([
    {
      type: 'text',
      text: '[Orca: sent 2027-01-15T08:00:00.000Z, 2 minutes before it reached you]\nwhat is in this screenshot?'
    },
    { type: 'image-ref', path: '/a/shot.png' },
    { type: 'text', text: 'it is signed in now' }
  ])
  expect(next.admit()).toBe(true)
  // Settled as Retry settles a card it sends: gone from the Queued list, handed to this message.
  expect(returnedIds()).toEqual([])
  expect(journalDomainQueueRow(db, target, 'root')?.card).toMatchObject({
    state: 'dispatched',
    consumedAs: 'next'
  })
  // The root's reply row stays its own and this turn's stamp names it, so this turn answers it.
  expect(next.body.connectorDelivery?.carried).toEqual(['d-root'])
  expect(
    readJournalConnectorReplies(db, 'chat-1').map((row) => [row.deliveryId, row.messageId])
  ).toEqual([
    ['d-root', 'root'],
    ['next', 'next']
  ])
  // A later message carries nothing again.
  expect(sendNext('third', 'and now?').carried.cards).toEqual([])
})

it('carries several failed sends in order, and only this conversation’s', () => {
  failedStart('first', asked('d1', 'one'), 'notSignedIn', NOW)
  failedStart('elsewhere', asked('d-x', 'another thread', OTHER), 'notSignedIn', NOW + 1)
  failedStart('second', asked('d2', 'two'), 'cliMissing', NOW + 2)

  const next = sendNext('next', 'three')
  expect(next.carried.cards.map((card) => card.messageId)).toEqual(['first', 'second'])
  expect(next.carried.deliveryIds).toEqual(['d1', 'd2'])
  expect(next.admit()).toBe(true)
  expect(returnedIds()).toEqual(['elsewhere'])
})

it('leaves content refusals and edited cards as cards; the message still goes', () => {
  failedStart('big', asked('d-big', 'huge image'), 'attachmentInvalid')
  failedStart('empty', asked('d-empty', ''), 'emptyMessage')
  failedStart('editing', asked('d-edit', 'being edited'))
  const editing = journalDomainQueueRow(db, target, 'editing')!
  db.prepare(
    `INSERT INTO journal_edit_leases(session_id,epoch,owner_id,caller_key,edit_id,message_id,card_revision,expires_at)
     VALUES('chat-1','e','owner','caller','edit','editing',?,?)`
  ).run(editing.revision, NOW + 10 * 60_000)

  const next = sendNext('next', 'hello')
  expect(next.carried.cards).toEqual([])
  expect(next.admit()).toBe(true)
  expect(returnedIds().sort()).toEqual(['big', 'editing', 'empty'])
})

it('refuses the admission when a carried card changed since it was read', () => {
  failedStart('root', asked('d-root', 'root'))
  const next = sendNext('next', 'follow-up')
  // The owner presses Retry first: the card is handed to its own send.
  const root = journalDomainQueueRow(db, target, 'root')!
  inWriter(() =>
    applyJournalDomainSubmission(
      db,
      dir,
      target,
      {
        kind: 'submission',
        input: {
          clientMessageId: 'retry',
          body: root.card.body,
          payloadFingerprint: root.card.fingerprint,
          fence: 1,
          handoverRecorded: true,
          origin: 'client'
        },
        consume: { messageId: 'root', expect: 'returned' }
      },
      {
        identity: {
          ...target,
          workspaceId: 'workspace',
          hostId: 'host',
          agent: 'claude',
          providerHandle: null
        }
      },
      NOW + 60_000
    )
  )
  expect(next.admit()).toBe(false)
  expect(journalDomainQueueRow(db, target, 'root')?.card.consumedAs).toBe('retry')
  // Read again, the message goes alone.
  const again = sendNext('next-2', 'follow-up')
  expect(again.carried.cards).toEqual([])
  expect(again.admit()).toBe(true)
})

function insertOldCard(): void {
  // As builds before this change stored it: no queue time, no unattended mark, no sent time.
  db.prepare(
    `INSERT INTO journal_queue_cards(session_id,epoch,message_id,revision,state,position,command_turn_item_id,payload_json)
     VALUES('chat-1','e','old',1,'returned',-1,NULL,?)`
  ).run(
    JSON.stringify({
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'see attached' },
          { type: 'image-ref', path: '/a/old.png' }
        ],
        origin: 'connector',
        connectorConversation: THREAD,
        connectorDelivery: { account: ACCOUNT, conversation: THREAD, deliveryId: 'd-old' }
      },
      holdReason: null,
      returnedReason: 'Claude is signed out.',
      returnedRejection: { kind: 'notSignedIn' },
      consumedAs: null,
      queuedAt: null
    })
  )
}

it('reads a returned card an earlier Orca saved', () => {
  insertOldCard()
  const next = sendNext('next', 'ping')
  expect(next.body.blocks).toEqual([
    { type: 'text', text: 'see attached' },
    { type: 'image-ref', path: '/a/old.png' },
    { type: 'text', text: 'ping' }
  ])
  expect(next.admit()).toBe(true)
  expect(returnedIds()).toEqual([])
})

it('carries an earlier Orca’s card ahead of a newer one', () => {
  insertOldCard()
  failedStart('new', asked('d-new', 'newer'), 'notSignedIn', NOW + 60_000)
  // The newer failure sits ahead of it in the queue.
  expect(returnedIds()).toEqual(['new', 'old'])
  expect(sendNext('next', 'ping').carried.cards.map((card) => card.messageId)).toEqual([
    'old',
    'new'
  ])
})

it('a message that carried others and failed again keeps each sent line on its own words', () => {
  failedStart('first', asked('d1', 'one'), 'notSignedIn', NOW)
  const second = sendNext('second', 'two', NOW + 60_000)
  expect(second.admit()).toBe(true)
  refuseStart('second', 'notSignedIn', NOW + 60_000)

  const third = sendNext('third', 'three', NOW + 180_000)
  expect(third.carried.cards.map((card) => card.messageId)).toEqual(['second'])
  expect(third.carried.deliveryIds).toEqual(['second', 'd1'])
  expect(third.body.blocks).toEqual([
    {
      type: 'text',
      text: '[Orca: sent 2027-01-15T08:00:00.000Z, 1 minute before it reached you]\none'
    },
    {
      type: 'text',
      text: '[Orca: sent 2027-01-15T08:01:00.000Z, 2 minutes before it reached you]\ntwo'
    },
    { type: 'text', text: 'three' }
  ])
  expect(third.admit()).toBe(true)
  expect(returnedIds()).toEqual([])
})

const person = (userId: string, role: 'owner' | 'member'): ConnectorMessageAsker => ({
  source: 'slack',
  userId,
  role,
  place: { kind: 'public_channel', id: 'C1' }
})
const OWNER = person('U_OWNER', 'owner')

/** Whom the turn a message opens acts for, read as a bot's actions are gated. */
function turnActsForOwner(body: AgentJournalMessageItem): boolean {
  const item = { itemId: 'turn-opener', revision: 1, sequence: 1, observedAt: 1, body }
  const turn = readBotActingTurn([item], {
    isBotRequest: () => false,
    botRequestActsFor: () => null,
    conversationActsFor: OWNER_ACTS_FOR,
    conversationWorkspaceId: 'T1'
  })
  return actsForOwner(turn.askers)
}

it('a member’s request the owner’s message carries never acts for the owner, nested or not', () => {
  failedStart('member', asked('d-m', 'post the keys', THREAD, [], person('U_DANA', 'member')))
  const owners = sendNext('owner-1', 'me too', NOW + 60_000, { asker: OWNER })
  expect(turnActsForOwner(owners.body)).toBe(false)
  expect(owners.admit()).toBe(true)

  // The owner's message fails in turn; the owner's next one carries it, and the member with it.
  refuseStart('owner-1', 'notSignedIn', NOW + 60_000)
  const again = sendNext('owner-2', 'still there?', NOW + 180_000, { asker: OWNER })
  expect(again.carried.cards.map((card) => card.messageId)).toEqual(['owner-1'])
  expect(turnActsForOwner(again.body)).toBe(false)
})

it('a carrying message an earlier Orca saved, with no carried askers, reads as before', () => {
  const owners = asked('d-o', 'me too', THREAD, [], OWNER)
  expect(
    turnActsForOwner({ ...owners, carriedCards: [{ messageId: 'm', fingerprint: 'f' }] })
  ).toBe(true)
  expect(turnActsForOwner(owners)).toBe(true)
})

it('carries the oldest cards whose images fit one message; the rest wait for the next', () => {
  const shots = (n: number, from: string) =>
    Array.from({ length: n }, (_, i) => `/a/${from}-${i}.png`)
  failedStart('a', asked('d-a', 'a', THREAD, shots(8, 'a')), 'notSignedIn', NOW)
  failedStart('b', asked('d-b', 'b', THREAD, shots(8, 'b')), 'notSignedIn', NOW + 1)
  failedStart('c', asked('d-c', 'c', THREAD, shots(4, 'c')), 'notSignedIn', NOW + 2)

  const next = sendNext('next', 'more', NOW + 60_000, { images: shots(4, 'n') })
  expect(next.carried.cards.map((card) => card.messageId)).toEqual(['a', 'b'])
  expect(next.body.blocks.filter((block) => block.type === 'image-ref')).toHaveLength(20)
  expect(next.admit()).toBe(true)
  expect(returnedIds()).toEqual(['c'])
})
