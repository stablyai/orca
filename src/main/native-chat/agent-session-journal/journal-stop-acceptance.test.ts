// What a person's Stop settles as it is accepted: the send it stops is withdrawn, as the turn it
// would have opened; the sends queued behind it become held cards; a send no card can carry is
// withdrawn in words that say so. A start the Stop ended settles what it was handed the same way.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { USER_MESSAGE_SOURCE } from '../../../shared/agent-session-message-source'
import { readAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureSentence } from '../../../shared/agent-session-failure-words'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import { structuredAgentSessionPayloadFingerprint } from '../../../shared/structured-agent-session-mutation'
import type { AgentSessionJournal } from './journal-store'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener
} from './journal-host-database-test-support'
import { holdUnsentSends } from './journal-unsent-send-hold'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-stop',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: claudeProviderHandle('native-1', null)
}
const WORDS = { agentName: 'Codex' }
/** What a withdrawn send records: the marker released clients hide, and the fact newer ones word. */
const WITHDRAWN = { reason: DISPATCH_REJECTED_CANCELLED, rejection: { kind: 'cancelled' } }
const RETURNED = 'Codex was stopped before it read this message, so it went back to the queue.'

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-stop-acceptance-'))
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function text(value: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text: value }] }
}

const IMAGE: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [
    { type: 'text', text: 'look' },
    { type: 'image-ref', path: '/tmp/attachment.png' }
  ]
}

async function open(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => (clock += 1),
    mintEpoch: () => 'epoch-1'
  })
}

/** A person's send, accepted and queued. */
async function accept(
  journal: AgentSessionJournal,
  id: string,
  body = text(`text of ${id}`)
): Promise<void> {
  await journal.appendSubmission({
    clientMessageId: id,
    payloadFingerprint: structuredAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: IDENTITY.sessionId,
      fields: { body }
    }),
    body,
    fence: 0,
    handoverRecorded: true,
    origin: 'client',
    source: USER_MESSAGE_SOURCE
  })
}

function handOver(journal: AgentSessionJournal, id: string) {
  return journal.resolveDispatch({
    clientMessageId: id,
    state: 'pending',
    fence: 0,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
}

function stop(journal: AgentSessionJournal) {
  return journal.stops.accept({
    event: { reason: 'user-stop' },
    fence: 0,
    hostInstance: 'host-instance',
    words: WORDS
  })
}

it('withdraws the send it stops when nothing runs ahead of it, and holds those behind it', async () => {
  const journal = await open()
  await accept(journal, 'first')
  await accept(journal, 'second')

  expect((await stop(journal)).settled).toEqual(['first', 'second'])

  expect(journal.submission('first')).toMatchObject({ dispatchState: 'rejected', ...WITHDRAWN })
  expect(journal.submission('first')).not.toHaveProperty('keptAsQueuedMessageId')
  expect(journal.submission('second')).toMatchObject({
    dispatchState: 'rejected',
    reason: RETURNED,
    rejection: { kind: 'returnedToQueue' },
    keptAsQueuedMessageId: 'second'
  })
  expect(journal.queuedMessages.list().map((card) => card.messageId)).toEqual(['second'])
  expect(journal.stopMarks.latest()).not.toBeNull()
})

it('holds every queued send behind a send already handed over', async () => {
  const journal = await open()
  await accept(journal, 'running')
  await handOver(journal, 'running')
  await accept(journal, 'behind')

  expect((await stop(journal)).settled).toEqual(['behind'])

  expect(journal.submission('running')).toMatchObject({ dispatchState: 'pending' })
  expect(journal.submission('behind')).toMatchObject({
    rejection: { kind: 'returnedToQueue' },
    keptAsQueuedMessageId: 'behind'
  })
})

// TEMPORARY until queued cards hold attachments: the words say it was withdrawn, never queued.
it('withdraws a send behind it that no card can carry, in words that say so', async () => {
  const journal = await open()
  await accept(journal, 'running')
  await handOver(journal, 'running')
  await accept(journal, 'image', IMAGE)

  await stop(journal)

  const image = journal.submission('image')
  expect(image).toMatchObject({ dispatchState: 'rejected', ...WITHDRAWN })
  expect(image).not.toHaveProperty('keptAsQueuedMessageId')
  expect(journal.queuedMessages.list()).toEqual([])
  // Every client words it from the fact: not sent, and nothing says it waits to run.
  const fact = readAgentSessionFailureFact(image?.rejection)
  expect(fact && agentSessionFailureSentence(fact, 'rejection', WORDS)).toBe(
    'This message was withdrawn before the agent started it.'
  )
})

it('leaves the first send a stopped start was handed to its end, and holds the rest', async () => {
  const journal = await open()
  for (const id of ['first', 'second', 'image']) {
    await accept(journal, id, id === 'image' ? IMAGE : undefined)
    await handOver(journal, id)
  }

  await holdUnsentSends(journal, {
    fence: 0,
    hostInstance: 'host-instance',
    hold: { cause: 'userStop', words: WORDS },
    unrun: true
  })

  // The child's end withdraws the one the Stop stopped (`unrunRejection`).
  expect(journal.submission('first')).toMatchObject({ dispatchState: 'pending' })
  expect(journal.submission('second')).toMatchObject({
    reason: RETURNED,
    keptAsQueuedMessageId: 'second'
  })
  expect(journal.submission('image')).toMatchObject(WITHDRAWN)
  expect(journal.queuedMessages.list().map((card) => card.messageId)).toEqual(['second'])
})
