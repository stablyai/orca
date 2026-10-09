// A draft sent back to waiting after a handed-over hand-off was rejected as
// never delivered is withdrawn when the provider echoes that message: the
// first send reached the agent, so sending it again would repeat it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { JournalQueuedMessages } from './journal-queued-messages'
import type { AgentSessionJournal } from './journal-store'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-q',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'claude',
  providerHandle: claudeProviderHandle('native-1', null)
}
const STOP_WITHDRAWAL = agentSessionFailureWords(agentSessionFailureFact('cancelled'), {
  surface: 'rejection'
})

let root: string
let clock = 1_000
const journals = createTrackedJournalOpener()

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function echo(journal: AgentSessionJournal, uuid: string, text: string) {
  return journal.appendItem({ provider: 'claude', sessionId: 'native-1', uuid }, message(text), {
    fence: 0,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
}

/** A draft consumed and handed to the agent, then rejected as never delivered (the provider
 *  confirmed a Stop withdrew it): back to waiting. `handedOver: false` rejects it before
 *  hand-over instead, which proves it was never written. */
async function withdrawnDraft(
  text: string,
  options: { handedOver: boolean } = { handedOver: true }
): Promise<AgentSessionJournal> {
  const journal = await open()
  await handOffAndReject(journal, text, options)
  return journal
}

function open(): Promise<AgentSessionJournal> {
  return journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => ++clock,
    mintEpoch: () => `epoch-${clock}`
  })
}

async function handOffAndReject(
  journal: AgentSessionJournal,
  text: string,
  options: { handedOver: boolean } = { handedOver: true }
): Promise<void> {
  const body = message(text)
  const fingerprint = agentSessionSendBodyFingerprint(IDENTITY.sessionId, body)
  await journal.queuedMessages.insert({
    messageId: 'draft-1',
    body,
    fingerprint,
    hostInstance: 'p'
  })
  await journal.appendSubmission(
    {
      clientMessageId: 'sub-draft-1',
      payloadFingerprint: fingerprint,
      body,
      fence: 0,
      handoverRecorded: true
    },
    { messageId: 'draft-1', expect: 'waiting', settledByOp: null }
  )
  if (options.handedOver) {
    await journal.resolveDispatch({
      clientMessageId: 'sub-draft-1',
      state: 'pending',
      fence: 0,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await journal.resolveDispatch({
      clientMessageId: 'sub-draft-1',
      state: 'rejected',
      ...STOP_WITHDRAWAL,
      fence: 0
    })
  } else {
    await journal.rejectQueuedSubmissions(0, STOP_WITHDRAWAL)
  }
  expect(journal.queuedMessages.get('draft-1')).toMatchObject({
    state: 'waiting',
    consumedAs: null
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-queued-echo-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe("a waiting draft whose 'never delivered' claim an echo disproves", () => {
  it('ignores an unreadable waiting draft in both the live hook and owed-echo repair', async () => {
    const journal = await withdrawnDraft('did it land?')
    const db = openTestJournalHostDatabase(root).db
    db.prepare("UPDATE queued_messages SET body_json = '{' WHERE message_id = 'draft-1'").run()
    await echo(journal, 'echo-1', 'did it land?')
    expect(journal.queuedMessages.get('draft-1')).toBeNull()
    expect(journal.queuedMessages.deliveredByEchoOwed()).toBe(false)
    await journal.queuedMessages.settleOwed()
    expect(
      db.prepare("SELECT state FROM queued_messages WHERE message_id = 'draft-1'").get()
    ).toEqual({ state: 'waiting' })
  })

  it('is withdrawn when the provider echoes the message it was withdrawn from', async () => {
    const journal = await withdrawnDraft('did it land?')
    await echo(journal, 'echo-1', 'did it land?')
    expect(journal.queuedMessages.get('draft-1')).toMatchObject({
      state: 'withdrawn',
      settledByOp: null
    })
    // The rejection stays terminal: the echo is kept apart, not folded into it.
    expect(journal.submission('sub-draft-1')?.dispatchState).toBe('rejected')
    expect(journal.snapshot().items.map((item) => item.itemId)).toHaveLength(2)
  })

  it('stays waiting when the rejected hand-off never reached the agent: the echo is some other message', async () => {
    const journal = await withdrawnDraft('did it land?', { handedOver: false })
    await echo(journal, 'echo-1', 'did it land?')
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('waiting')
  })

  it('stays waiting for an echo of some other text', async () => {
    const journal = await withdrawnDraft('did it land?')
    await echo(journal, 'echo-1', 'something else')
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('waiting')
  })

  it('stays waiting when a live send of the same text claims the echo', async () => {
    const journal = await withdrawnDraft('did it land?')
    const body = message('did it land?')
    await journal.appendSubmission({
      clientMessageId: 'typed-again',
      payloadFingerprint: agentSessionSendBodyFingerprint(IDENTITY.sessionId, body),
      body,
      fence: 0,
      handoverRecorded: true
    })
    await echo(journal, 'echo-1', 'did it land?')
    expect(journal.submission('typed-again')?.dispatchState).toBe('accepted')
    expect(journal.queuedMessages.get('draft-1')?.state).toBe('waiting')
  })

  describe('when the per-row hook was skipped', () => {
    it('the re-derivation withdraws it from the echo already in the journal, and at reopen', async () => {
      let journal = await withdrawnDraft('did it land?')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const hook = vi
        .spyOn(JournalQueuedMessages.prototype, 'onRowInTransaction')
        .mockImplementationOnce(() => {
          throw new Error('bookkeeping failed')
        })
      try {
        await echo(journal, 'echo-1', 'did it land?')
      } finally {
        hook.mockRestore()
        warn.mockRestore()
      }
      expect(journal.queuedMessages.get('draft-1')?.state).toBe('waiting')
      expect(journal.queuedMessages.deliveredByEchoOwed()).toBe(true)
      // The drain's heal, before the draft could send again.
      await journal.queuedMessages.settleOwed()
      expect(journal.queuedMessages.get('draft-1')?.state).toBe('withdrawn')
      expect(journal.queuedMessages.deliveredByEchoOwed()).toBe(false)
      await journal.close()
      journal = await open()
      expect(journal.queuedMessages.get('draft-1')?.state).toBe('withdrawn')
    })

    it('an unclaimed echo from before the hand-off proves nothing about it', async () => {
      const journal = await open()
      await echo(journal, 'typed-in-the-agent', 'did it land?')
      await handOffAndReject(journal, 'did it land?')
      expect(journal.queuedMessages.deliveredByEchoOwed()).toBe(false)
      await journal.queuedMessages.settleOwed()
      expect(journal.queuedMessages.get('draft-1')?.state).toBe('waiting')
    })
  })
})
