import { describe, expect, it } from 'vitest'
import {
  extractPendingAsk,
  scanPendingAsks,
  asyncQuestionOccurrenceId
} from '../../shared/native-chat/input/native-chat-ask'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { NativeChatMessage } from '../../shared/native-chat-types'
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
