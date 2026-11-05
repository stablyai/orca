import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import { createTrackedJournalOpener } from '../store-lifecycle/journal-host-database-test-support'
import type { AgentSessionJournal } from '../journal-store'
import { QueuedMessageNotConsumableError } from './queued-message-consume-error'
import '../../agent-session-wire/delivery/structured-agent-session-queued-gate'
import '../../agent-session-wire/observations/structured-agent-session-current-work'
import '../../agent-session-record-test-fixture'
import '../input-order/journal-input-candidates'
import '../../agent-session-wire/delivery/structured-agent-session-queued-publication'
import '../../agent-session-wire/publication/subscribers/structured-agent-session-subscribers'

const personal = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

const mail = (mailbox: string, messageId: string): AgentJournalMessageItem => ({
  ...personal(`mail ${messageId}`),
  from: {
    kind: 'agent',
    senders: [],
    orchestration: {
      message: 'mail-notice',
      mailbox,
      dispatchId: null,
      messages: [{ messageId, runId: 'run', from: 'term_worker' }]
    }
  }
})

const roots: string[] = []
const journals = createTrackedJournalOpener()

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A journal whose queue reads mail authority through `unavailable`, as the host installs it. */
async function queue(unavailable: Set<string>): Promise<AgentSessionJournal> {
  const root = await mkdtemp(join(tmpdir(), 'orca-queue-mail-'))
  roots.push(root)
  const journal = await journals.open({
    identity: {
      sessionId: 'queue-mail',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'claude' as const,
      providerHandle: claudeProviderHandle('thread', null)
    },
    stateDirectory: root
  })
  journal.queuedMessages.mailUnavailable = (card) => unavailable.has(card.messageId)
  return journal
}

const next = (journal: AgentSessionJournal) => journal.queuedMessages.nextInputCard()?.messageId

function handOver(journal: AgentSessionJournal, messageId: string) {
  const card = journal.queuedMessages.get(messageId)!
  return journal.appendSubmission(
    {
      clientMessageId: `handoff-${messageId}`,
      origin: 'host',
      payloadFingerprint: card.fingerprint,
      body: card.body,
      fence: 0,
      handoverRecorded: true
    },
    { messageId, expect: 'waiting', yieldsToPause: true }
  )
}

describe("the queue's one rule for the next card", () => {
  it('uses the same steering selection at consume, retaining normal FIFO and command barriers', async () => {
    const journal = await queue(new Set())
    await journal.queuedMessages.insert({ messageId: 'person', body: personal('next') })
    await journal.queuedMessages.insert({ messageId: 'report', body: mail('run:r', 'm') })
    expect(next(journal)).toBe('person')
    expect(journal.queuedMessages.nextInputCard(true, true)?.messageId).toBe('report')
    await expect(handOver(journal, 'report')).rejects.toBeInstanceOf(
      QueuedMessageNotConsumableError
    )
    const card = journal.queuedMessages.get('report')!
    await journal.appendSubmission(
      {
        clientMessageId: 'steered',
        origin: 'host',
        payloadFingerprint: card.fingerprint,
        body: card.body,
        fence: 0,
        handoverRecorded: true
      },
      { messageId: 'report', expect: 'waiting', yieldsToPause: true, steer: true }
    )
    expect(next(journal)).toBe('person')
    await journal.queuedMessages.insert({
      messageId: 'command',
      body: { ...personal('/compact'), command: { name: 'compact' } }
    })
    await journal.queuedMessages.insert({ messageId: 'later', body: mail('run:r', 'later') })
    expect(journal.queuedMessages.nextInputCard(true, true)).toBeNull()
  })

  it("passes mail it cannot decide on for the person's next card, never a held one", async () => {
    const journal = await queue(new Set(['A']))
    await journal.queuedMessages.insert({ messageId: 'A', body: mail('run:r', 'm1') })
    await journal.queuedMessages.insert({ messageId: 'B', body: personal('failed earlier') })
    await journal.queuedMessages.insert({ messageId: 'C', body: personal('next question') })
    await journal.queuedMessages.hold({
      messageIds: ['B'],
      reason: QUEUED_MESSAGE_PAUSED_SEND_FAILED
    })
    expect(next(journal)).toBe('C')
    // The consume check applies the same rule: the held card is never handed over automatically.
    await expect(handOver(journal, 'B')).rejects.toBeInstanceOf(QueuedMessageNotConsumableError)
    await handOver(journal, 'C')
    expect(journal.queuedMessages.get('B')?.state).toBe('waiting')
  })

  it('keeps later mail behind it, from any mailbox, and an edit behind it holds everything', async () => {
    const journal = await queue(new Set(['A']))
    await journal.queuedMessages.insert({ messageId: 'A', body: mail('run:r', 'm1') })
    await journal.queuedMessages.insert({ messageId: 'B', body: mail('dispatch:d', 'm2') })
    expect(next(journal)).toBeUndefined()
    await journal.queuedMessages.insert({ messageId: 'C', body: personal('mine') })
    expect(next(journal)).toBe('C')
    journal.queuedMessages.editLeases.acquire(
      { callerKey: 'desktop', editId: 'edit-b' },
      { messageId: 'B', fingerprint: journal.queuedMessages.get('B')!.fingerprint }
    )
    expect(next(journal)).toBeUndefined()
  })

  it('hands the mail over first once it can be decided, and the consume check agrees', async () => {
    const unavailable = new Set(['A'])
    const journal = await queue(unavailable)
    await journal.queuedMessages.insert({ messageId: 'A', body: mail('run:r', 'm1') })
    await journal.queuedMessages.insert({ messageId: 'C', body: personal('mine') })
    expect(next(journal)).toBe('C')
    unavailable.clear()
    expect(next(journal)).toBe('A')
    await expect(handOver(journal, 'C')).rejects.toBeInstanceOf(QueuedMessageNotConsumableError)
    await handOver(journal, 'A')
  })

  it('reconsiders a cleared personal card behind unavailable mail when Resume lifts its pause', async () => {
    const journal = await queue(new Set(['A']))
    await journal.queuedMessages.insert({ messageId: 'C', body: personal('held across clear') })
    await journal.context.clear(
      { operationId: 'clear', afterFence: 0, clearedAt: 1 },
      { write: () => {}, committed: () => {} }
    )
    await journal.queuedMessages.insert({ messageId: 'A', body: mail('run:r', 'm1') })
    await journal.queuedMessages.move({ messageId: 'A', beforeMessageId: 'C' })
    expect(next(journal)).toBeUndefined()
    await journal.appendQueueResume(0)
    expect(next(journal)).toBe('C')
    await handOver(journal, 'C')
    expect(journal.queuedMessages.get('C')?.state).toBe('dispatched')
  })
})
