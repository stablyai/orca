// Which unsent sends a restart or a close keeps as held cards, where they go in the queue, and that
// a send's source is recorded and folded.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import {
  USER_MESSAGE_SOURCE,
  type AgentMessageSource,
  type AgentSessionMessageSource
} from '../../../shared/agent-session-message-source'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { QUEUED_MESSAGE_PAUSED_KEPT } from '../../../shared/agent-session-queued-message-wire'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import { structuredAgentSessionCompactBody } from '../agent-session-wire/structured-agent-session-command-turn'
import {
  holdUnsentSends,
  unsentSendKeptAsCard,
  type UnsentSendHold
} from './journal-unsent-send-hold'
import type { AgentSessionJournal } from './journal-store'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  updateTestJournalRowJson
} from './journal-host-database-test-support'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-held',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: claudeProviderHandle('native-1', null)
}
const HOST_RESTARTED = agentSessionFailureWords(agentSessionFailureFact('hostRestarted'), {
  surface: 'rejection'
})
const CHAT_CLOSED = agentSessionFailureWords(agentSessionFailureFact('chatClosed'), {
  surface: 'rejection'
})
/** The live host process the cards are written for. */
const HOST = 'host-instance-2'

let root: string
let clock = 1_000
let epochs = 0
const journals = createTrackedJournalOpener()

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function fingerprint(body: AgentJournalMessageItem): string {
  return structuredAgentSessionPayloadFingerprint({
    method: 'agentSession.send',
    sessionId: IDENTITY.sessionId,
    fields: { body }
  })
}

async function open(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => `epoch-${(epochs += 1)}`
  })
}

function hold(journal: AgentSessionJournal, settle: UnsentSendHold = { cause: 'hostRestarted' }) {
  return holdUnsentSends(journal, { fence: 0, hostInstance: HOST, hold: settle })
}

/** Orchestration mail as the mailbox sends it: from another agent, naming its sender. */
const MAIL_SOURCE: AgentMessageSource = {
  kind: 'agent',
  senders: [
    {
      party: { address: 'agent:coordinator', terminalHandle: null, orcaSessionId: null },
      name: null
    }
  ],
  orchestration: { message: 'mail-notice', mailbox: 'agent:worker', dispatchId: null, messages: [] }
}

async function accept(
  journal: AgentSessionJournal,
  id: string,
  fields: {
    body?: AgentJournalMessageItem
    origin?: 'client' | 'host'
    source?: AgentSessionMessageSource
  } = {}
): Promise<void> {
  const body = fields.body ?? message(`text of ${id}`)
  await journal.appendSubmission({
    clientMessageId: id,
    payloadFingerprint: fingerprint(body),
    body,
    fence: 0,
    handoverRecorded: true,
    ...(fields.origin ? { origin: fields.origin } : {}),
    ...(fields.source ? { source: fields.source } : {})
  })
}

/** Writes rows as a process that then quit, and opens the journal again as the next one. */
async function afterRestart(
  write: (journal: AgentSessionJournal) => Promise<void>
): Promise<AgentSessionJournal> {
  const earlier = await open()
  await write(earlier)
  await earlier.close()
  return open()
}

/** Rewrites a stored submission's `source` as another build would have written it. */
function storeSubmissionSourceAs(journal: AgentSessionJournal, id: string, source: unknown): void {
  const seq = journal.submission(id)?.submittedSequence
  const { db } = openTestJournalHostDatabase(root)
  const stored = liveTestJournalRows(db, IDENTITY.sessionId).find((row) => row.seq === seq)
  if (!stored) {
    throw new Error(`no stored row for ${id}`)
  }
  const row: unknown = JSON.parse(stored.rowJson)
  updateTestJournalRowJson(
    db,
    IDENTITY.sessionId,
    stored.seq,
    JSON.stringify({ ...(typeof row === 'object' ? row : {}), source })
  )
}

function cardOrder(journal: AgentSessionJournal): string[] {
  return journal.queuedMessages
    .list()
    .filter((card) => card.state === 'waiting')
    .map((card) => card.messageId)
}

beforeEach(async () => {
  epochs = 0
  root = await mkdtemp(join(tmpdir(), 'orca-unsent-hold-'))
})

afterEach(async () => {
  await journals.closeAll()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

describe('which sends an earlier host process left unsent are kept', () => {
  it('keeps a person’s and a launch’s text, and an older build’s client send', async () => {
    const journal = await afterRestart(async (earlier) => {
      await accept(earlier, 'person', { origin: 'client', source: USER_MESSAGE_SOURCE })
      await accept(earlier, 'launch', { origin: 'host', source: USER_MESSAGE_SOURCE })
      await accept(earlier, 'legacy-client', { origin: 'client' })
    })
    await hold(journal)

    expect(cardOrder(journal)).toEqual(['person', 'launch', 'legacy-client'])
    await journal.close()
    // The rejection names the card it was kept as, read back from disk.
    const reopened = await open()
    for (const id of ['person', 'launch', 'legacy-client']) {
      expect(reopened.submission(id)).toMatchObject({
        dispatchState: 'rejected',
        ...HOST_RESTARTED,
        keptAsQueuedMessageId: id
      })
      expect(reopened.queuedMessages.get(id)).toMatchObject({
        state: 'waiting',
        holdReason: QUEUED_MESSAGE_PAUSED_KEPT,
        hostInstance: HOST,
        body: message(`text of ${id}`),
        fingerprint: fingerprint(message(`text of ${id}`)),
        carriedFrom: null,
        queuedAt: { epoch: 'epoch-1', sequence: reopened.submission(id)?.acceptedSequence }
      })
    }
  })

  it('rejects mail, a dispatch preamble, a continuation, /compact, an image, and a send no one can attribute', async () => {
    const image: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'look' },
        { type: 'image-ref', path: '/tmp/attachment.png' }
      ]
    }
    const journal = await afterRestart(async (earlier) => {
      await accept(earlier, 'mail', { origin: 'host', source: MAIL_SOURCE })
      await accept(earlier, 'dispatch', { origin: 'host' })
      await accept(earlier, 'continuation', { origin: 'host' })
      await accept(earlier, 'compact', {
        origin: 'client',
        source: USER_MESSAGE_SOURCE,
        body: structuredAgentSessionCompactBody()
      })
      await accept(earlier, 'image', { origin: 'client', source: USER_MESSAGE_SOURCE, body: image })
      await accept(earlier, 'legacy-host', { origin: 'host' })
      await accept(earlier, 'no-origin')
    })
    await hold(journal)

    expect(journal.queuedMessages.list()).toEqual([])
    for (const id of [
      'mail',
      'dispatch',
      'continuation',
      'compact',
      'image',
      'legacy-host',
      'no-origin'
    ]) {
      expect(journal.submission(id)).toMatchObject({ dispatchState: 'rejected', ...HOST_RESTARTED })
      expect(journal.submission(id)).not.toHaveProperty('keptAsQueuedMessageId')
    }
  })

  // Only a Send the person asked for comes back kept; the queue's own hand-off waits under the
  // restart's pause, where it stood.
  it.each([
    { by: 'Send now', origin: 'client' as const, holdReason: QUEUED_MESSAGE_PAUSED_KEPT },
    { by: 'the queue', origin: 'host' as const, holdReason: null }
  ])(
    'a card’s own hand-off by $by returns its card, and makes no second one',
    async ({ origin, holdReason }) => {
      const journal = await afterRestart(async (earlier) => {
        await earlier.queuedMessages.insert({
          messageId: 'card',
          body: message('card text'),
          fingerprint: fingerprint(message('card text')),
          hostInstance: 'proc-1'
        })
        await earlier.appendSubmission(
          {
            clientMessageId: 'handoff',
            payloadFingerprint: fingerprint(message('card text')),
            body: message('card text'),
            fence: 0,
            handoverRecorded: true,
            origin
          },
          { messageId: 'card', expect: 'waiting', settledByOp: null }
        )
      })
      await hold(journal)

      expect(journal.queuedMessages.list()).toHaveLength(1)
      expect(journal.queuedMessages.get('card')).toMatchObject({
        state: 'waiting',
        consumedAs: null,
        holdReason
      })
      expect(journal.queuedMessages.get('handoff')).toBeNull()
    }
  )

  it('leaves alone what this process accepted', async () => {
    const journal = await open()
    await accept(journal, 'mine', { origin: 'client', source: USER_MESSAGE_SOURCE })
    await hold(journal)
    expect(journal.submission('mine')?.dispatchState).toBe('pending')
    expect(journal.queuedMessages.list()).toEqual([])
  })

  it('never keeps a queue hand-off, a card’s link, or a send with no message body', () => {
    const body = message('x')
    expect(unsentSendKeptAsCard({ source: USER_MESSAGE_SOURCE }, body)).toBe(body)
    expect(unsentSendKeptAsCard({ origin: 'client', source: { kind: 'agent' } }, body)).toBeNull()
    // Undecodable (folded as an empty kind) and unknown kinds are never a person's.
    expect(unsentSendKeptAsCard({ origin: 'client', source: { kind: '' } }, body)).toBeNull()
    expect(unsentSendKeptAsCard({ origin: 'client', source: { kind: 'orca' } }, body)).toBeNull()
    expect(unsentSendKeptAsCard({ origin: 'client', queuedMessageId: 'card' }, body)).toBeNull()
    expect(unsentSendKeptAsCard({ origin: 'client' }, null)).toBeNull()
  })

  // Only a row with no source at all is an older build's; a newer build's kind may name a sender
  // that must not become a card.
  it('never keeps a source kind this build does not know, whatever its origin', async () => {
    const journal = await afterRestart(async (earlier) => {
      await earlier.appendSubmission({
        clientMessageId: 'future',
        payloadFingerprint: fingerprint(message('from a newer build')),
        body: message('from a newer build'),
        fence: 0,
        handoverRecorded: true,
        origin: 'client',
        source: USER_MESSAGE_SOURCE
      })
      storeSubmissionSourceAs(earlier, 'future', { kind: 'a-newer-kind' })
    })
    expect(journal.submission('future')?.source).toEqual({ kind: 'a-newer-kind' })
    await hold(journal)
    expect(journal.queuedMessages.list()).toEqual([])
    expect(journal.submission('future')).toMatchObject({ dispatchState: 'rejected' })
  })

  // A source with no readable kind is not a row without one: an older build's rule never applies.
  it('never keeps a send whose stored source has no readable kind', async () => {
    const journal = await afterRestart(async (earlier) => {
      await earlier.appendSubmission({
        clientMessageId: 'unreadable',
        payloadFingerprint: fingerprint(message('unreadable')),
        body: message('unreadable'),
        fence: 0,
        handoverRecorded: true,
        origin: 'client',
        source: USER_MESSAGE_SOURCE
      })
      storeSubmissionSourceAs(earlier, 'unreadable', {})
    })
    expect(journal.submission('unreadable')?.source).toEqual({ kind: '' })
    await hold(journal)
    expect(journal.queuedMessages.list()).toEqual([])
    expect(journal.submission('unreadable')).toMatchObject({ dispatchState: 'rejected' })
  })
})

describe('where kept sends go in the queue', () => {
  // A Send the person asked for comes back kept among them; the queue's own hand-off stays put.
  it.each([
    { by: 'Send now', origin: 'client' as const, order: ['A', 'H', 'B', 'C'] },
    { by: 'the queue', origin: 'host' as const, order: ['A', 'B', 'H', 'C'] }
  ])(
    'in acceptance order, ahead of the cards already waiting, a hand-off by $by among them',
    async ({ origin, order }) => {
      const journal = await afterRestart(async (earlier) => {
        await earlier.queuedMessages.insert({
          messageId: 'H',
          body: message('H'),
          fingerprint: fingerprint(message('H')),
          hostInstance: 'proc-1'
        })
        await earlier.queuedMessages.insert({
          messageId: 'C',
          body: message('C'),
          fingerprint: fingerprint(message('C')),
          hostInstance: 'proc-1'
        })
        await accept(earlier, 'A', { origin: 'client', source: USER_MESSAGE_SOURCE })
        await earlier.appendSubmission(
          {
            clientMessageId: 'H-handoff',
            payloadFingerprint: fingerprint(message('H')),
            body: message('H'),
            fence: 0,
            handoverRecorded: true,
            origin
          },
          { messageId: 'H', expect: 'waiting', settledByOp: null }
        )
        await accept(earlier, 'B', { origin: 'client', source: USER_MESSAGE_SOURCE })
      })
      await hold(journal)

      expect(cardOrder(journal)).toEqual(order)
    }
  )

  it('a run a crash cut short is placed again with the rest, in acceptance order', async () => {
    const interrupted = await afterRestart(async (earlier) => {
      await earlier.queuedMessages.insert({
        messageId: 'C',
        body: message('C'),
        fingerprint: fingerprint(message('C')),
        hostInstance: 'proc-1'
      })
      await accept(earlier, 'A', { origin: 'client', source: USER_MESSAGE_SOURCE })
      await accept(earlier, 'B', { origin: 'client', source: USER_MESSAGE_SOURCE })
    })
    // That run kept A, at a stale place behind C, then died before B.
    await interrupted.resolveDispatch(
      { clientMessageId: 'A', state: 'rejected', ...HOST_RESTARTED, fence: 0, recovered: true },
      (db) => {
        interrupted.queuedMessages.holdInTransaction(db, {
          card: {
            messageId: 'A',
            body: message('text of A'),
            fingerprint: fingerprint(message('text of A')),
            hostInstance: HOST,
            holdReason: QUEUED_MESSAGE_PAUSED_KEPT,
            queuedAt: {
              epoch: 'epoch-1',
              sequence: interrupted.submission('A')!.acceptedSequence!
            },
            position: 5
          },
          positions: []
        })
      }
    )
    await interrupted.close()
    const journal = await open()
    await hold(journal)

    expect(cardOrder(journal)).toEqual(['A', 'B', 'C'])
  })
})

describe('a close of the chat', () => {
  it('keeps a person’s unsent send in place, rejected as closed, by the same rule as a restart', async () => {
    const journal = await open()
    await accept(journal, 'person', { origin: 'client', source: USER_MESSAGE_SOURCE })
    await accept(journal, 'mail', { origin: 'host', source: MAIL_SOURCE })
    await hold(journal, { cause: 'chatClosed' })

    expect(cardOrder(journal)).toEqual(['person'])
    expect(journal.queuedMessages.get('person')).toMatchObject({
      holdReason: QUEUED_MESSAGE_PAUSED_KEPT,
      hostInstance: HOST
    })
    for (const id of ['person', 'mail']) {
      expect(journal.submission(id)).toMatchObject({ dispatchState: 'rejected', ...CHAT_CLOSED })
    }
  })

  it('settles only what `which` names, leaving a later send queued', async () => {
    const journal = await open()
    await accept(journal, 'before', { origin: 'client', source: USER_MESSAGE_SOURCE })
    await accept(journal, 'after', { origin: 'client', source: USER_MESSAGE_SOURCE })
    await hold(journal, {
      cause: 'chatClosed',
      which: (submission) => submission.clientMessageId === 'before'
    })

    expect(cardOrder(journal)).toEqual(['before'])
    expect(journal.submission('after')?.dispatchState).toBe('pending')
  })
})

describe('the order kept cards stand in', () => {
  // Sequences restart with each epoch, so a card kept before a rewind has no sequence to compare.
  it('a card kept before the epoch rolled stays ahead of one kept after it', async () => {
    const journal = await afterRestart(async (earlier) => {
      for (const id of ['m1', 'm2', 'm3']) {
        await accept(earlier, id, { origin: 'host', source: MAIL_SOURCE })
      }
      await accept(earlier, 'A', { origin: 'client', source: USER_MESSAGE_SOURCE })
    })
    await hold(journal)
    await journal.rollEpoch('handle_forked', 0)
    await accept(journal, 'B', { origin: 'client', source: USER_MESSAGE_SOURCE })
    await journal.close()
    const reopened = await open()
    await hold(reopened)

    expect(reopened.queuedMessages.get('A')?.queuedAt?.epoch).not.toBe(
      reopened.queuedMessages.get('B')?.queuedAt?.epoch
    )
    expect(cardOrder(reopened)).toEqual(['A', 'B'])
  })
})

describe('the source a send records', () => {
  it('is folded from the row; a row without one folds without it', async () => {
    const journal = await open()
    await accept(journal, 'with-source', { origin: 'host', source: USER_MESSAGE_SOURCE })
    await accept(journal, 'without', { origin: 'client' })
    const folded: AgentJournalSubmission | undefined = journal.submission('with-source')
    expect(folded?.source).toEqual({ kind: 'user' })
    expect(journal.submission('without')).not.toHaveProperty('source')
  })

  // Who sent it stays on the card, host-only; a submission is published to clients as it folds.
  it('keeps only the kind of an agent’s source, never its senders', async () => {
    const journal = await open()
    await accept(journal, 'mail', { origin: 'host', source: MAIL_SOURCE })
    await journal.close()
    const reopened = await open()
    expect(reopened.submission('mail')?.source).toEqual({ kind: 'agent' })
    expect(JSON.stringify(reopened.submission('mail'))).not.toContain('agent:coordinator')
  })
})
