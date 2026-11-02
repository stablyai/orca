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
import { journalInputOrder } from './journal-input-order'
import { nextStructuredQueuedMessage } from '../agent-session-wire/structured-agent-session-queued-messages'
import type { QueuedMessageRow } from './queued-message-table'

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
    const work = (prompt: boolean) =>
      ({
        activeTurnId: () => null,
        owesSend: () => false,
        hasActionablePrompt: () => prompt
      }) as never
    const record = {} as never
    for (let publication = 0; publication < 10; publication += 1) {
      expect(nextStructuredQueuedMessage({ journal, record: null, work: work(false) })).toBeNull()
      expect(nextStructuredQueuedMessage({ journal, record, work: work(true) })).toBeNull()
    }
    expect(authority).not.toHaveBeenCalled()
    expect(nextStructuredQueuedMessage({ journal, record, work: work(false) })).toBeNull()
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
      expect(next(journal)).toBe('C')
      // Reads of the queue's live order: a walk reads up to its stop, a filtered copy reads all.
      const cards = journalInputOrder(journal.queuedMessages.inputState()).cards as unknown as {
        ordered: QueuedMessageRow[]
      }
      let reads = 0
      const counted: QueuedMessageRow[] = []
      cards.ordered.forEach((card, index) => {
        Object.defineProperty(counted, index, {
          enumerable: true,
          get: () => {
            reads += 1
            return card
          }
        })
      })
      cards.ordered = counted
      for (let selection = 0; selection < 10; selection += 1) {
        expect(next(journal)).toBe('C')
      }
      // A binary search to the mail card, then one step: nothing proportional to the cards behind.
      expect(reads).toBeLessThanOrEqual(10 * 12)
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
      // The head and the one card behind it, per selection: nothing proportional to the old cards.
      expect(reads).toHaveBeenCalledTimes(20)
      expect(lists).not.toHaveBeenCalled()
    }
  )
})
