import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  type AgentJournalMessageItem,
  AGENT_JOURNAL_THREAD_SCOPE
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { structuredAgentSessionPayloadFingerprint } from '../../../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'

import { readAgentSessionHistory } from '../agent-session-history-page'

import { fixture, IDENTITY, body, item } from './agent-session-history-contract-test-fixture'

describe('projectJournalBatch', () => {
  it('publishes every nested lifecycle mutation atomically at the outer cursor', async () => {
    const turn: AgentJournalItemIdentity = {
      provider: 'legacy',
      agent: 'codex',
      sessionId: 'session-1',
      recordId: 'turn-lifecycle:turn-1'
    }
    await fixture.journal.appendItem(
      turn,
      { kind: 'status', text: 'working' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const cursor = fixture.journal.cursor()
    await fixture.journal.appendLifecycleBatch({
      settlementId: 'settlement-1',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          identity: item(1),
          body: body('one'),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        },
        {
          kind: 'item',
          identity: item(2),
          body: body('two'),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        },
        { kind: 'tombstone', identity: turn }
      ]
    })

    const page = readAgentSessionHistory(fixture.journal, {
      sessionId: 'session-1',
      direction: 'after',
      cursor,
      limit: 1
    })
    if (!page.ok) {
      throw new Error(`expected a page, got reset ${page.reset}`)
    }
    expect(page.page.items.map((entry) => entry.body)).toEqual([body('one'), body('two')])
    expect(page.page.removedItemIds).toHaveLength(1)
    expect(new Set(page.page.items.map((entry) => entry.sequence)).size).toBe(1)

    const tail = readAgentSessionHistory(fixture.journal, {
      sessionId: 'session-1',
      direction: 'tail',
      limit: 1
    })
    if (!tail.ok) {
      throw new Error(`expected a page, got reset ${tail.reset}`)
    }
    expect(tail.page.items.map((entry) => entry.body)).toEqual([body('one'), body('two')])
  })

  it('publishes a mismatched provider echo under its submission slot', async () => {
    const message: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'queued follow-up' }]
    }
    await fixture.journal.appendSubmission({
      clientMessageId: 'client-follow-up',
      payloadFingerprint: structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: IDENTITY.sessionId,
        fields: { body: message }
      }),
      body: message,
      fence: 1
    })
    const cursor = fixture.journal.cursor()
    await fixture.journal.resolveDispatch({
      clientMessageId: 'client-follow-up',
      state: 'accepted',
      providerIdentity: {
        provider: 'codex',
        threadId: 'thread-1',
        turnId: 'predicted',
        ordinal: 0
      },
      fence: 1
    })
    await fixture.journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'root-turn', ordinal: 2 },
      message,
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )

    const page = readAgentSessionHistory(fixture.journal, {
      sessionId: IDENTITY.sessionId,
      direction: 'after',
      cursor
    })
    if (!page.ok) {
      throw new Error(`expected a page, got reset ${page.reset}`)
    }
    expect(page.page.items).toMatchObject([
      { itemId: agentJournalSubmissionKey('client-follow-up'), revision: 1 }
    ])
    expect(page.page.removedItemIds).toEqual([])
  })
})
