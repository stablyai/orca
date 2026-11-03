import { describe, expect, it } from 'vitest'
import {
  extractPendingAsk,
  scanPendingAsks,
  asyncQuestionOccurrenceId
} from '../../shared/native-chat/input/native-chat-ask'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState
} from '../native-chat/agent-session-journal/journal-reducer'
import { journalItemRowBuilder } from '../native-chat/agent-session-journal/journal-row-builders'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../shared/agent-session/structured-agent-session-reducer'
import { projectStructuredAgentSessionMessages } from '../../shared/agent-session/view/structured-agent-session-message-projection'
import { nativeChatAskDismissKey } from '../../shared/native-chat/input/native-chat-ask-dismiss-key'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { NativeChatMessage } from '../../shared/native-chat/native-chat-types'
import {
  codexItemBody,
  codexItemIdentity,
  CodexTurnOrdinals
} from './codex-structured-item-translation'

describe('Codex async question items', () => {
  it('carries an async question on its message so clients can answer it', () => {
    const body = codexItemBody({
      type: 'agentMessage',
      id: 'call-async',
      text: 'Which color?\n- Red\n- Blue',
      phase: 'final_answer',
      delivery: 'async',
      questions: [
        { title: 'Which color?', options: ['Red', 'Blue'] },
        { title: 'Why?', options: null }
      ]
    })
    const blocks = body?.kind === 'message' ? body.blocks : []

    expect(blocks[0]).toEqual({ type: 'text', text: 'Which color?\n- Red\n- Blue' })
    expect(
      extractPendingAsk([
        { id: 'm', role: 'assistant', blocks, timestamp: null, source: 'transcript' }
      ])
    ).toEqual({
      replyAsMessage: true,
      questions: [
        {
          question: 'Which color?',
          multiSelect: false,
          options: [{ label: 'Red' }, { label: 'Blue' }]
        },
        { question: 'Why?', multiSelect: false, options: [] }
      ]
    })
  })

  it('keeps a resumed async item dismissed when provider IDs renumber, but identifies later rows', () => {
    function project(rawId: string, ordinals: CodexTurnOrdinals): NativeChatMessage {
      const item = {
        type: 'agentMessage',
        id: rawId,
        text: 'Which color?',
        delivery: 'async',
        questions: [{ title: 'Which color?', options: ['Red', 'Blue'] }]
      }
      const body = codexItemBody(item)
      if (body?.kind !== 'message') {
        throw new Error('Expected an async message')
      }
      return {
        id: agentJournalItemKey(
          codexItemIdentity({ threadId: 'thread', turnId: 'turn', item, ordinals })
        ),
        role: 'assistant',
        blocks: body.blocks,
        timestamp: null,
        source: 'transcript'
      }
    }
    const liveOrdinals = new CodexTurnOrdinals()
    const live = project('live-call-async', liveOrdinals)
    const resumed = project('item-0', new CodexTurnOrdinals())
    const key = (row: NativeChatMessage) =>
      asyncQuestionOccurrenceId(
        'journal/host/thread/epoch',
        scanPendingAsks([row]).contributors[0]!
      )
    expect(live.id).toBe(resumed.id)
    expect(key(live)).not.toBeNull()
    expect(key(resumed)).toBe(key(live))
    expect(key(project('later-call-async', liveOrdinals))).not.toBe(key(live))
  })
})

it('keeps a revised existing question available through the translator, both reducers and client preview', () => {
  const host = createJournalReducerState('session', 'epoch')
  let sequence = 0
  const scheduled: (() => void)[] = []
  const translator = createCodexJournalTranslator({
    sink: {
      appendItem: (identity, body) =>
        applyJournalRow(
          host,
          journalItemRowBuilder(() => host, identity, body, {
            fence: 1,
            turnScope: host.derivedTurnScope.scopeFor(body)
          })(++sequence, sequence)
        ),
      appendTombstone: () => {},
      publish: () => {}
    },
    bindPromptItemId: () => {},
    schedule: (run) => {
      scheduled.push(run)
      return () => {}
    }
  })
  const notify = (method: string, params: unknown) => {
    translator.handle({
      type: 'notification',
      sessionId: 'session',
      threadId: 'thread',
      method,
      params
    })
    for (const run of scheduled.splice(0)) {
      run()
    }
  }
  notify('turn/started', { turn: { id: 'turn' } })
  const question = (id: string) => ({
    type: 'agentMessage',
    id,
    text: 'A?',
    delivery: 'async',
    questions: [{ title: 'A?', options: ['Yes', 'No'] }]
  })
  notify('item/completed', { item: question('first') })
  notify('item/started', { item: { type: 'agentMessage', id: 'revised', text: 'Thinking' } })
  let client = EMPTY_STRUCTURED_AGENT_SESSION
  const publish = () => {
    const snapshot = renderJournalState(host)
    client = reduceStructuredAgentSession(client, {
      type: 'history-page',
      page: {
        sessionId: 'session',
        epoch: 'epoch',
        direction: 'tail',
        items: snapshot.items,
        submissions: snapshot.submissions,
        removedItemIds: [],
        window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch', sequence: 0 } },
        liveCursor: { epoch: 'epoch', sequence },
        hasOlder: false,
        hasNewer: false
      }
    })
    return projectStructuredAgentSessionMessages(
      client.items,
      [
        {
          clientMessageId: 'answer',
          queuedAt: 1,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '> A?\n\nYes' }] }
        }
      ],
      client.submissions
    )
  }
  const before = publish()
  const oldPosition = before.find((row) =>
    row.blocks.some((block) => block.type === 'text' && block.text === 'Thinking')
  )!.journalPosition
  const original = nativeChatAskDismissKey(extractPendingAsk(before))
  notify('item/completed', { item: question('revised') })
  const after = publish()
  const scan = scanPendingAsks(after)
  expect(scan.contributors).toHaveLength(2)
  expect(
    after.find((row) => row.id === scan.contributors[1]!.sourceRowId)!.journalPosition
  ).toEqual(oldPosition)
  expect(scan.answerPending).toBeUndefined()
  expect(nativeChatAskDismissKey(extractPendingAsk(after))).not.toBe(original)
})

it('uses actual handover movement past Q2 and retires only after acceptance', () => {
  const host = createJournalReducerState('session', 'epoch')
  const base = (seq: number) => ({ v: 1, epoch: 'epoch', seq, fence: 1, ts: seq })
  const question = (itemId: string) => ({
    kind: 'item' as const,
    itemId,
    revision: 0,
    body: codexItemBody({
      type: 'agentMessage',
      id: itemId,
      text: 'A?',
      delivery: 'async',
      questions: [{ title: 'A?', options: ['Yes', 'No'] }]
    })!
  })
  applyJournalRow(host, { ...question('first'), ...base(1) })
  applyJournalRow(host, {
    kind: 'submission',
    clientMessageId: 'answer',
    providerHandle: { kind: 'codex', threadId: 'thread' },
    payloadFingerprint: 'answer',
    handoverRecorded: true,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Yes' }] },
    ...base(2)
  })
  applyJournalRow(host, { ...question('later'), ...base(3) })
  const scan = () => {
    const snapshot = renderJournalState(host)
    return scanPendingAsks(
      projectStructuredAgentSessionMessages(snapshot.items, [], snapshot.submissions)
    )
  }
  expect(scan().answerPending).toBeUndefined()
  applyJournalRow(host, {
    kind: 'dispatch',
    clientMessageId: 'answer',
    state: 'pending',
    providerItemId: null,
    reason: null,
    ...base(4)
  })
  expect(host.items.get(agentJournalSubmissionKey('answer'))!.sequence).toBe(4)
  expect(scan().contributors).toHaveLength(2)
  expect(scan().answerPending).toBe(true)
  applyJournalRow(host, {
    kind: 'dispatch',
    clientMessageId: 'answer',
    state: 'accepted',
    providerItemId: null,
    reason: null,
    ...base(5)
  })
  expect(scan().contributors).toHaveLength(0)
})
