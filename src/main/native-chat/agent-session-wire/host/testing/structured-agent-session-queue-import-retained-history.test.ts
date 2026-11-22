import { agentSessionSendBodyFingerprint } from '../../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { expect, it } from 'vitest'
import type { JournalRow } from '../../../agent-session-journal/durable-rows/journal-row-schema'
import { agentJournalSubmissionKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { readTestJournalItems } from '../../../agent-session-journal/journal-observation.test-support'
import { readAgentSessionHistory } from '../../publication/history/agent-session-history-page'
import {
  base,
  founding,
  sourceHandle,
  sessionId,
  message,
  seed,
  seedLegacyCard,
  open
} from './structured-agent-session-queue-import-contract.test-fixture'

it.each([false, true])(
  'keeps personal Stop provenance after conversion and reopen (retained=%s)',
  async (retained) => {
    const body = message('sent')
    const rows: JournalRow[] = [
      founding,
      {
        ...base(2),
        kind: 'queue',
        messageId: 'W',
        change: { op: 'queued', body: message('waiting'), position: 1, queuedAt: null }
      },
      {
        ...base(3),
        kind: 'tombstone',
        itemId: 'orca:stop',
        revision: 1,
        stopEvent: { reason: 'user-stop', at: 1_000 }
      },
      {
        ...base(4),
        kind: 'submission',
        clientMessageId: 'H',
        queuedMessageId: 'S',
        origin: 'client',
        body,
        payloadFingerprint: 'sent',
        providerHandle: sourceHandle,
        handoverRecorded: true
      },
      {
        ...base(5),
        kind: 'dispatch',
        clientMessageId: 'H',
        state: 'pending',
        providerItemId: null,
        reason: null
      },
      {
        ...base(6),
        kind: 'dispatch',
        clientMessageId: 'H',
        state: 'accepted',
        providerItemId: null,
        reason: null
      }
    ]
    seed(rows, retained)
    seedLegacyCard('S', body, 'H')
    for (let round = 0; round < 2; round++) {
      const journal = await open()
      expect(await journal.queuedMessages.get('S')).toMatchObject({
        state: 'dispatched',
        consumedAs: 'H'
      })
      expect(await journal.queuedMessages.userStopInForce()).toBeNull()
      expect((await journal.queuedMessages.nextInputCard())?.messageId).toBe('W')
      await journal.close()
    }
  }
)

it.each([false, true])(
  'keeps Stop in force for a frozen mail handoff (retained=%s)',
  async (retained) => {
    const body = {
      ...message('sent'),
      from: { kind: 'agent' as const, senders: [], orchestration: null }
    }
    seed(
      [
        founding,
        {
          ...base(2),
          kind: 'queue',
          messageId: 'W',
          change: { op: 'queued', body: message('waiting'), position: 1, queuedAt: null }
        },
        {
          ...base(3),
          kind: 'tombstone',
          itemId: 'orca:stop',
          revision: 1,
          stopEvent: { reason: 'user-stop', at: 1_000 }
        },
        {
          ...base(4),
          kind: 'submission',
          clientMessageId: 'H',
          queuedMessageId: 'S',
          origin: 'host',
          source: { kind: 'agent' },
          body,
          payloadFingerprint: 'sent',
          providerHandle: sourceHandle,
          handoverRecorded: true
        },
        {
          ...base(5),
          kind: 'dispatch',
          clientMessageId: 'H',
          state: 'accepted',
          providerItemId: null,
          reason: null
        }
      ],
      retained
    )
    seedLegacyCard('S', body, 'H')
    for (let round = 0; round < 2; round++) {
      const journal = await open()
      expect(await journal.queuedMessages.get('S')).toMatchObject({
        state: 'dispatched',
        consumedAs: 'H'
      })
      expect(await journal.queuedMessages.userStopInForce()).toMatchObject({
        event: { reason: 'user-stop' }
      })
      expect(await journal.queuedMessages.nextInputCard()).toBeNull()
      await journal.close()
    }
  }
)

it.each([false, true])(
  'pages converted history and keeps a late queue echo in one bubble after reopen (retained=%s)',
  async (retained) => {
    const rows: JournalRow[] = [
      founding,
      {
        ...base(2),
        kind: 'submission',
        clientMessageId: 'u',
        queuedMessageId: 'q',
        body: message('stopped words'),
        payloadFingerprint: agentSessionSendBodyFingerprint(sessionId, message('stopped words')),
        providerHandle: sourceHandle,
        handoverRecorded: true
      }
    ]
    for (let index = 0; index < 205; index++) {
      rows.push({
        ...base(rows.length + 1),
        kind: 'item',
        itemId: `codex:history:t:${index}`,
        revision: 1,
        body: { ...message(`${index}:${'x'.repeat(4_000)}`), role: 'assistant' },
        turnScope: { kind: 'thread' }
      })
    }
    rows.push({
      ...base(rows.length + 1),
      kind: 'dispatch',
      clientMessageId: 'u',
      state: 'unknown',
      providerItemId: null,
      reason: 'reply lost'
    })
    seed(rows, retained)
    seedLegacyCard('q', message('stopped words'))
    let journal = await open()
    const history: string[] = []
    let page = await readAgentSessionHistory(journal, { sessionId, direction: 'tail' })
    for (;;) {
      expect(page.ok).toBe(true)
      history.unshift(...page.page.items.map((item) => item.itemId))
      if (!page.page.hasOlder) {
        break
      }
      page = await readAgentSessionHistory(journal, {
        sessionId,
        direction: 'before',
        cursor: page.page.window.nextCursor
      })
    }
    expect(new Set(history).size).toBe(history.length)
    expect(history).toHaveLength(206)
    const before = await journal.reads.item(agentJournalSubmissionKey('u'))
    const providerIdentity = {
      provider: 'codex' as const,
      threadId: 'history',
      turnId: 't',
      ordinal: 206
    }
    await journal.settleLateDispatch({
      clientMessageId: 'u',
      state: 'accepted',
      fence: 0,
      providerIdentity
    })
    await journal.appendItem(providerIdentity, message('stopped words'), {
      fence: 0,
      turnScope: { kind: 'thread' }
    })
    await journal.close()
    journal = await open()
    const echoes = (await readTestJournalItems(journal)).filter(
      (item) => item.body.kind === 'message' && item.body.role === 'user'
    )
    expect(echoes).toHaveLength(1)
    expect(echoes[0]).toMatchObject({
      itemId: before!.itemId,
      sequence: before!.sequence,
      observedAt: before!.observedAt
    })
    expect(await journal.reads.submission('u')).toMatchObject({ dispatchState: 'accepted' })
  }
)
