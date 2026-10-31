import { journalItemEchoFields } from '../native-chat/agent-session-journal/journal-item-echo'
import { expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  chat as catchUpChat,
  turn as catchUpTurn
} from './codex-structured-thread-catch-up.test'
import { agentSessionSendBodyFingerprint } from '../../shared/structured-agent-session-send-mutation'
import { agentSessionFailureFact } from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { structuredRewindCut } from '../native-chat/agent-session-wire/structured-rewind-cut'
import { restoreJournal } from '../native-chat/agent-session-journal/journal-open'

export function registerCodexCatchUpEchoTests(input: {
  chat: typeof catchUpChat
  turn: typeof catchUpTurn
  sessionId: string
  threadId: string
}): void {
  const { chat, turn, sessionId: SESSION, threadId: THREAD } = input
  it('uses saved native IDs only for display, preserving sends and drafts through outside echoes and replay', async () => {
    const c = await chat({ now: 1_000 })
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'continue' },
        { type: 'image-ref', path: '/attachment.png' }
      ]
    }
    const fingerprint = agentSessionSendBodyFingerprint(SESSION, body)
    await c.journal.queuedMessages.insert({
      messageId: 'draft',
      body
    })
    const states = ['unknown', 'rejected'] as const
    for (const state of states) {
      await c.journal.appendSubmission(
        {
          clientMessageId: state,
          body,
          payloadFingerprint: fingerprint,
          fence: 1,
          handoverRecorded: true
        },
        state === 'rejected' ? { messageId: 'draft', expect: 'waiting' } : undefined
      )
      await c.journal.resolveDispatch({
        clientMessageId: state,
        state: 'pending',
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await (state === 'unknown'
        ? c.journal.markPendingSubmissionsUnknown(1)
        : c.journal.resolveDispatch({
            clientMessageId: state,
            state: 'rejected',
            ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), {
              surface: 'rejection'
            }),
            fence: 1
          }))
    }
    await c.reopen()
    const before = c.journal.snapshot()
    const draft = c.journal.queuedMessages.get('draft')
    const receipts = states.map((state) => c.journal.receiptFor(state))
    const native = states.map((state, n) => ({
      ...turn(n + 2),
      items: [
        {
          type: 'userMessage',
          id: `u-${n + 2}`,
          clientId: state,
          content: [{ type: 'text', text: 'different historical rendering' }]
        },
        { type: 'agentMessage', id: `a-${n + 2}`, text: `answer ${n + 2}` }
      ]
    }))
    const outside = {
      ...turn(7),
      items: [
        {
          type: 'userMessage',
          id: 'outside',
          clientId: 'foreign-request',
          content: [
            { type: 'text', text: 'continue' },
            { type: 'localImage', path: '/attachment.png' }
          ]
        },
        { type: 'agentMessage', id: 'outside-answer', text: 'outside answer' }
      ]
    }
    await c.open([...native, outside])
    expect(c.texts().slice(-4)).toEqual([
      'assistant:answer 3',
      '(continued-outside)',
      'user:continue',
      'assistant:outside answer'
    ])
    expect(c.journal.snapshot().items.slice(0, before.items.length)).toEqual(before.items)
    expect(states.map((state) => c.journal.receiptFor(state))).toEqual(receipts)
    expect(c.texts().filter((text) => text.includes('historical rendering'))).toEqual([])
    expect(c.journal.snapshot().submissions).toEqual(before.submissions)
    expect(c.journal.queuedMessages.get('draft')).toEqual(draft)
    const outsideKey = agentJournalItemKey({
      provider: 'codex',
      threadId: THREAD,
      turnId: 'turn-7',
      ordinal: 0
    })
    expect(journalItemEchoFields(c.journal.itemProvenance(outsideKey))).toEqual({ echoOf: null })
    const whole = c.journal.snapshot()
    await c.reopen()
    await c.open([...native, outside])
    expect(c.journal.snapshot()).toEqual(whole)
    expect(c.journal.queuedMessages.get('draft')).toEqual(draft)
    const restored = restoreJournal(c.db, SESSION)
    expect(restored?.state.queue.cards.get('draft')).toEqual(draft)
  })

  it('keeps native display identity after a real retained cut and disk reopen', async () => {
    const c = await chat({ now: 1_000 })
    await c.open([turn(1)])
    const clientMessageId = `native-${'u'.repeat(1100)}`
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'original rich prompt' },
        { type: 'image-ref', path: '/kept.png' }
      ]
    }
    await c.journal.appendSubmission({
      clientMessageId,
      body,
      payloadFingerprint: agentSessionSendBodyFingerprint(SESSION, body),
      fence: 1,
      handoverRecorded: true
    })
    await c.journal.resolveDispatch({
      clientMessageId,
      state: 'pending',
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await c.journal.markPendingSubmissionsUnknown(1)
    await c.open([turn(1), turn(2), turn(3)])
    const key = agentJournalItemKey({ provider: 'orca', clientMessageId })
    const cut = structuredRewindCut(c.journal, {
      itemId: agentJournalItemKey({
        provider: 'codex',
        threadId: THREAD,
        turnId: 'turn-3',
        ordinal: 0
      }),
      provider: 'codex',
      nativeId: THREAD
    })
    if (!cut) {
      throw new Error('missing native retention cut')
    }
    await c.journal.replaceEpochItems('handle_forked', 1, cut.kept)
    await c.reopen()
    const prompt = c.journal.item(key)
    expect(prompt?.body).toEqual(body)
    expect(c.journal.submission(clientMessageId)).toBeUndefined()
    const native = {
      ...turn(4),
      items: [
        {
          type: 'userMessage',
          id: 'native',
          clientId: clientMessageId,
          content: [{ type: 'text', text: 'provider rendering' }]
        },
        { type: 'agentMessage', id: 'reply', text: 'native answer' }
      ]
    }
    const before = c.journal.snapshot()
    const beforeTexts = c.texts()
    await c.open([turn(1), turn(2), native])
    expect(c.journal.item(key)).toEqual(prompt)
    expect(c.journal.snapshot().items.slice(0, before.items.length)).toEqual(before.items)
    expect(c.texts()).toEqual([...beforeTexts, 'assistant:native answer'])
    expect(c.journal.submission(clientMessageId)).toBeUndefined()
    expect(c.journal.receiptFor(clientMessageId)).toBeNull()
    const whole = c.journal.snapshot()
    await c.reopen()
    await c.open([turn(1), turn(2), native])
    expect(c.journal.snapshot()).toEqual(whole)
  })
}
