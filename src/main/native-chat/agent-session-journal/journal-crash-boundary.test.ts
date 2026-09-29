// The crash boundary: the host wrote a submission row, dispatched, and died
// before it learned whether the provider took the message. The send stays in
// doubt for good — never re-sent, never dropped from the conversation.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { hasUnansweredStructuredAgentSessionDispatch } from '../../../shared/structured-agent-session-projection'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { digestPayload } from './journal-payload-bounds'
import { createTrackedJournalOpener } from './journal-store-test-open'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

const TURN_ID = '019fd8ca-edbe-7c43-b231-4c7aea3a2d89'

const ACCEPTED_IDENTITY: AgentJournalItemIdentity = {
  provider: 'codex',
  threadId: 'thread-1',
  turnId: TURN_ID,
  ordinal: 0
}

let root: string
let clock = 1_000

function tick(): number {
  clock += 1
  return clock
}

function userMessage(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

const LEGACY_CODEX_TURN_UNNAMED = 'codex app-server started a turn it did not name in time'

const journals = createTrackedJournalOpener()

async function open() {
  return journals.open({
    identity: IDENTITY,
    journalDir: root,
    now: tick,
    mintEpoch: () => `epoch-${clock}`
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-crash-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('crash between provider accept and journal commit', () => {
  it('leaves the send in doubt, and in the conversation, never re-sent', async () => {
    const journal = await open()
    await journal.appendSubmission({
      clientMessageId: 'cm_1',
      payloadFingerprint: digestPayload('deploy the thing'),
      body: userMessage('deploy the thing'),
      fence: 1
    })
    // Host dies here: the provider may have the message, but no dispatch row was written.

    const restarted = await open()
    expect(restarted.pendingSubmissions().map((entry) => entry.clientMessageId)).toEqual(['cm_1'])
    await restarted.markPendingSubmissionsUnknown(2)
    expect(restarted.submissions()[0]?.dispatchState).toBe('unknown')
    // Marks the send as outlived by its writer, so no reader reports it as still working.
    expect(restarted.submissions()[0]?.recovered).toBe(true)
    expect(restarted.snapshot().items.map((item) => item.itemId)).toEqual([
      agentJournalSubmissionKey('cm_1')
    ])
    expect(restarted.pendingSubmissions()).toHaveLength(0)
  })

  it('retires an ack timeout on restart without changing its delivery verdict', async () => {
    const journal = await open()
    await journal.appendSubmission({
      clientMessageId: 'cm_timeout',
      payloadFingerprint: digestPayload('slow'),
      body: userMessage('slow'),
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'cm_timeout',
      state: 'unknown',
      reason: 'ack timeout',
      fence: 1
    })
    expect(hasUnansweredStructuredAgentSessionDispatch(journal.submissions())).toBe(true)
    const restarted = await open()
    await restarted.markPendingSubmissionsUnknown(2)
    expect(restarted.submissions()[0]?.dispatchState).toBe('unknown')
    expect(hasUnansweredStructuredAgentSessionDispatch(restarted.submissions())).toBe(false)
    const cursor = restarted.cursor()
    await restarted.markPendingSubmissionsUnknown(2)
    expect(restarted.cursor()).toEqual(cursor)
  })

  it('leaves a rejected write failure settled across a restart', async () => {
    const journal = await open()
    await journal.appendSubmission({
      clientMessageId: 'cm_write_failed',
      payloadFingerprint: digestPayload('never left the process'),
      body: userMessage('never left the process'),
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'cm_write_failed',
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('writeFailed'), { surface: 'rejection' }),
      fence: 1
    })

    const restarted = await open()
    await restarted.markPendingSubmissionsUnknown(2)

    // A restart re-opens what it could not answer. This one is already answered,
    // so recovery must not reopen it as doubt.
    expect(restarted.submissions()[0]).toMatchObject({
      dispatchState: 'rejected',
      reason: 'provider_write_failed'
    })
    expect(restarted.submissions()[0]?.recovered).toBeUndefined()
    expect(hasUnansweredStructuredAgentSessionDispatch(restarted.submissions())).toBe(false)
  })

  // Only an older Orca minted this reason -- Codex now settles a send on the
  // provider echo -- but rows written under it still come back from disk.
  it('keeps a codex turn it could not name in doubt, never rejected', async () => {
    const journal = await open()
    await journal.appendSubmission({
      clientMessageId: 'cm_codex_unnamed',
      payloadFingerprint: digestPayload('codex is running this'),
      body: userMessage('codex is running this'),
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'cm_codex_unnamed',
      state: 'unknown',
      reason: LEGACY_CODEX_TURN_UNNAMED,
      fence: 1
    })

    const restarted = await open()
    await restarted.markPendingSubmissionsUnknown(2, 'provider_exited_before_acknowledgement')

    // The turn IS started; recovery may not overwrite that with a weaker guess,
    // and it may never become a rejection, which would license a re-delivery.
    expect(restarted.submissions()[0]).toMatchObject({
      dispatchState: 'unknown',
      reason: LEGACY_CODEX_TURN_UNNAMED,
      recovered: true
    })
  })

  it('survives replay of a settled journal without changing the answer', async () => {
    const journal = await open()
    await journal.appendSubmission({
      clientMessageId: 'cm_1',
      payloadFingerprint: digestPayload('once'),
      body: userMessage('once'),
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'cm_1',
      state: 'accepted',
      providerIdentity: ACCEPTED_IDENTITY,
      fence: 1
    })
    const settled = journal.snapshot()

    const reopened = await open()
    expect(reopened.snapshot()).toEqual(settled)
    expect(reopened.pendingSubmissions()).toHaveLength(0)
  })

  it('keeps the receipt across a reopen', async () => {
    const journal = await open()
    await journal.appendSubmission({
      clientMessageId: 'cm_1',
      payloadFingerprint: digestPayload('kept'),
      body: userMessage('kept'),
      fence: 1
    })
    await journal.resolveDispatch({
      clientMessageId: 'cm_1',
      state: 'accepted',
      providerIdentity: ACCEPTED_IDENTITY,
      fence: 1
    })
    await journal.close()

    const reopened = await open()
    expect(reopened.receiptFor('cm_1')?.providerItemId).toBe(agentJournalItemKey(ACCEPTED_IDENTITY))
  })
})
