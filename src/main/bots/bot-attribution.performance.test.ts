// Perf contract for STA-18558 (#48774's attribution reads): who a turn acts for and whether it may
// leave its thread read Orca's record of each message's send. One index of the read's submissions
// serves every message a turn took; a search per message re-read every submission for each one, and
// a turn a bot request opened checked its messages for a paired device's stamp twice.
import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTypedBy } from '../../shared/agent-session/journal/agent-journal-typed-by'
import { OWNER_ACTS_FOR } from '../../shared/bots/bot-acts-for'
import { journalSubmission, ORCA_SEND, PERSON_SEND } from './bot-journal-submission.test-fixture'
import { leaveThreadRefusal } from './bot-leave-thread-authority'
import { readBotActingTurn, type BotActingTurnLookups } from './bot-request-asker'

const MESSAGES = 64
const THREAD = { source: 'slack', externalId: 'T1:C1:1800000000.000100:U0BOT' }
const RUNNING = {
  turnScope: { kind: 'turn', turnItemId: 't1' }
} satisfies Partial<AgentJournalRenderItem>

let submissionReads = 0
let typedByReads = 0

const row = (
  itemId: string,
  body: AgentJournalItemBody,
  extra: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem => ({
  itemId,
  revision: 1,
  sequence: 0,
  observedAt: 0,
  body,
  ...extra
})

/** A message the owner typed at the host's window; `countTypedBy` counts each read of its stamp. */
function typedAtHost(countTypedBy = false): AgentJournalItemBody {
  const body: AgentJournalItemBody = { kind: 'message', role: 'user', blocks: [] }
  const typedBy: AgentJournalTypedBy = { by: 'host' }
  return Object.defineProperty(body, 'typedBy', {
    enumerable: true,
    get: () => {
      typedByReads += countTypedBy ? 1 : 0
      return typedBy
    }
  })
}

/** A send whose client id counts each time a reader looks at it. */
function countedSend(fields: Partial<AgentJournalSubmission> & { clientMessageId: string }) {
  const { clientMessageId } = fields
  return Object.defineProperty(journalSubmission(fields), 'clientMessageId', {
    enumerable: true,
    get: () => {
      submissionReads += 1
      return clientMessageId
    }
  })
}

/** The running turn: opened by `opener`, with the owner's messages steered in up to `MESSAGES`. */
function runningTurn(opener: AgentJournalItemBody, countTypedBy = false) {
  const items = [
    row('u1', opener),
    row('t1', { kind: 'turn', turnId: 'p1', state: 'running', userItemId: 'u1' }),
    ...Array.from({ length: MESSAGES - 1 }, (_, n) =>
      row(`s${n}`, typedAtHost(countTypedBy), RUNNING)
    )
  ]
  return items.map((item, index) => ({ ...item, sequence: index + 1, observedAt: index + 1 }))
}

/** Every message's own send, the newest message's first: each search finds its send late. */
function sendsOf(items: readonly AgentJournalRenderItem[]): AgentJournalSubmission[] {
  return items
    .filter((item) => item.body.kind === 'message')
    .map((item, n) =>
      countedSend({ clientMessageId: `c${n}`, providerItemId: item.itemId, ...PERSON_SEND })
    )
    .toReversed()
}

/** Sends of other messages only: every search reads them all and finds none. */
const unrelatedSends = (): AgentJournalSubmission[] =>
  Array.from({ length: MESSAGES }, (_, n) =>
    countedSend({ clientMessageId: `x${n}`, providerItemId: `px${n}`, ...ORCA_SEND })
  )

const requestMail: AgentJournalItemBody = {
  kind: 'message',
  role: 'user',
  blocks: [],
  from: {
    kind: 'agent',
    senders: [],
    orchestration: {
      message: 'mail-notice',
      mailbox: 'asker',
      dispatchId: null,
      messages: [{ messageId: 'req-1', runId: 'run-1', from: 'asker' }]
    }
  }
}
const REQUESTER = [{ kind: 'unknown' }] satisfies BotActingTurnLookups['conversationActsFor']
const lookups: BotActingTurnLookups = {
  isBotRequest: (messageId) => messageId === 'req-1',
  botRequestActsFor: () => ({ askers: REQUESTER }),
  conversationActsFor: OWNER_ACTS_FOR,
  conversationWorkspaceId: 'T1'
}

function count(read: () => unknown) {
  submissionReads = 0
  typedByReads = 0
  const result = read()
  return { result, submissionReads, typedByReads }
}

// Hardcoded: reads for a turn that took 64 messages over 64 submissions. Opening the turn reads
// each submission once, and the index once more.
describe('STA-18558: attribution reads each submission once per read', () => {
  it('for a turn a bot request opened, which the owner steered into without a send on record', () => {
    const items = runningTurn(requestMail)
    const submissions = unrelatedSends()
    const read = count(() => readBotActingTurn(items, lookups, submissions))
    expect(read.result).toMatchObject({ askedBy: REQUESTER, actingOnRequestId: 'req-1' })
    expect(read.submissionReads).toBe(128)
  })

  it('for a turn the owner typed every message of at the host', () => {
    const items = runningTurn(typedAtHost())
    const submissions = sendsOf(items)
    const read = count(() => readBotActingTurn(items, lookups, submissions))
    expect(read.result).toMatchObject({ rootItemId: 'u1', typedByOwner: true })
    expect(read.submissionReads).toBe(128)
  })

  it('for whether the running turn may leave its thread', () => {
    const items = runningTurn(typedAtHost())
    const submissions = sendsOf(items)
    const read = count(() => leaveThreadRefusal(items, submissions, THREAD))
    expect(read.result).toBeNull()
    expect(read.submissionReads).toBe(128)
  })

  it('checks a request turn for a paired device once', () => {
    const items = runningTurn(requestMail, true)
    const read = count(() => readBotActingTurn(items, lookups, unrelatedSends()))
    expect(read.result).toMatchObject({ askedBy: REQUESTER })
    expect(read.typedByReads).toBe(126)
  })
})
