import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session/requests/agent-session-queued-message-wire'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import type { AgentSessionJournal } from './journal-store'
import { QueuedMessageNotConsumableError } from './queued-message-consume-error'
import { nextStructuredQueuedMessage } from '../agent-session-wire/structured-agent-session-queued-messages'
import { structuredAgentSessionCurrentWork } from '../agent-session-wire/structured-agent-session-current-work'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import type { QueuedMessageRow } from './queued-message-table'
import { JournalInputCandidates } from './journal-input-candidates'
import { readQueuePublication } from '../agent-session-wire/structured-agent-session-queued-publication'
import { AgentSessionSubscribers } from '../agent-session-wire/structured-agent-session-subscribers'

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

/** Cards the walk past undecidable head mail reads, counted from now. The prototype is spied: a
 *  commit applies the queue's derived owners back onto themselves, dropping an instance's own spy. */
function countWalk(): () => number {
  const walk = JournalInputCandidates.prototype.after
  let visits = 0
  vi.spyOn(JournalInputCandidates.prototype, 'after').mockImplementation(function* (
    this: JournalInputCandidates,
    card: QueuedMessageRow
  ) {
    for (const candidate of walk.call(this, card)) {
      visits += 1
      yield candidate
    }
  })
  return () => visits
}

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

  it('asks mail authority only once nothing else stops a send', async () => {
    const journal = await queue(new Set())
    const authority = vi.fn((_card: QueuedMessageRow) => true)
    journal.queuedMessages.mailUnavailable = authority
    await journal.queuedMessages.insert({ messageId: 'A', body: mail('run:r', 'm1') })
    // Idle: no turn running and nothing owed, so only the gates below can stop a send.
    const work = structuredAgentSessionCurrentWork(journal, { record: null })
    const prompt = vi.spyOn(work, 'hasActionablePrompt')
    const record = agentSessionRecordFixture({ sessionId: 'queue-mail' })
    for (let publication = 0; publication < 10; publication += 1) {
      prompt.mockReturnValue(false)
      expect(nextStructuredQueuedMessage({ journal, record: null, work })).toBeNull()
      prompt.mockReturnValue(true)
      expect(nextStructuredQueuedMessage({ journal, record, work })).toBeNull()
    }
    expect(authority).not.toHaveBeenCalled()
    prompt.mockReturnValue(false)
    expect(nextStructuredQueuedMessage({ journal, record, work })).toBeNull()
    expect(authority).toHaveBeenCalledTimes(1)
  })

  it.each([40, 400])(
    'stops at the first card it can send, however many of %i wait behind it',
    async (behind) => {
      const journal = await queue(new Set(['A']))
      await journal.queuedMessages.insert({ messageId: 'A', body: mail('run:r', 'm1') })
      await journal.queuedMessages.insert({ messageId: 'C', body: personal('mine') })
      for (let card = 0; card < behind; card += 1) {
        await journal.queuedMessages.insert({ messageId: `later-${card}`, body: personal('later') })
      }
      const visits = countWalk()
      // Each new card changes what lies past the mail, so each insert is walked again: to C and no further.
      for (let insert = 0; insert < 10; insert += 1) {
        await journal.queuedMessages.insert({ messageId: `new-${insert}`, body: personal('new') })
        expect(next(journal)).toBe('C')
        expect(next(journal)).toBe('C')
      }
      expect(visits()).toBe(10)
    }
  )

  it.each([40, 400])(
    'reads %i mail cards behind undecidable mail once, not on every publication',
    async (count) => {
      const journal = await queue(new Set(['A']))
      await journal.queuedMessages.insert({ messageId: 'A', body: mail('run:r', 'm1') })
      for (let card = 1; card < count; card += 1) {
        await journal.queuedMessages.insert({
          messageId: `m-${card}`,
          body: mail('run:r', `m-${card}`)
        })
      }
      const work = structuredAgentSessionCurrentWork(journal, { record: null })
      const record = agentSessionRecordFixture({ sessionId: 'queue-mail' })
      const gate = () => ({ record, work })
      const emit = vi.fn()
      const subscribers = new AgentSessionSubscribers({
        readQueuePublication: () => readQueuePublication(journal, gate)
      })
      const stops = [
        subscribers.open({ id: 'desktop', sessionId: 'queue-mail', journal, fence: 0, emit }),
        subscribers.open({
          id: 'phone',
          sessionId: 'queue-mail',
          journal,
          fence: 0,
          emit,
          boundedFrames: true
        }),
        journal.observeCommits(() => subscribers.publish('queue-mail', journal))
      ]
      emit.mockClear()
      const visits = countWalk()
      const gets = vi.spyOn(journal.queuedMessages, 'get')
      for (let write = 0; write < 10; write += 1) {
        await journal.appendItem(
          { provider: 'orca', clientMessageId: 'unrelated-status' },
          { kind: 'status', text: `status-${write}` },
          { fence: 0, turnScope: { kind: 'thread' } }
        )
      }
      // Desktop and phone both hear ten writes that change nothing queued: no queue frame, no walk.
      expect(emit.mock.calls.some(([event]) => event.queuedMessages !== undefined)).toBe(false)
      expect(visits()).toBe(0)
      // The head and its authority, per publication per consumer, whatever waits behind it.
      expect(gets.mock.calls.length).toBe(20)
      stops.forEach((stop) => stop())
    }
  )

  it.each([40, 400])(
    'walks only live cards, however many of %i old cards the epoch keeps',
    async (old) => {
      const journal = await queue(new Set(['A']))
      for (let card = 0; card < old; card += 1) {
        await journal.queuedMessages.insert({ messageId: `old-${card}`, body: personal('done') })
      }
      await journal.queuedMessages.withdraw(Array.from({ length: old }, (_, card) => `old-${card}`))
      await journal.queuedMessages.insert({ messageId: 'A', body: mail('run:r', 'm1') })
      await journal.queuedMessages.insert({ messageId: 'C', body: personal('mine') })
      const reads = vi.spyOn(journal.queuedMessages, 'get')
      const lists = vi.spyOn(journal.queuedMessages, 'list')
      for (let selection = 0; selection < 10; selection += 1) {
        expect(next(journal)).toBe('C')
      }
      // The head per selection, and the one card behind it once: nothing proportional to the old cards.
      expect(reads).toHaveBeenCalledTimes(11)
      expect(lists).not.toHaveBeenCalled()
    }
  )
})
