import { describe, expect, it } from 'vitest'
import { ANTIGRAVITY_ACP_DIALECT } from '../acp-dialects/antigravity-dialect'
import { AcpHistoryJournalOverlay } from '../history/acp-history-journal-overlay'
import { createProviderTimelineAssembler } from '../../native-chat/agent-session-timeline/provider-timeline-assembler'
import type { ProviderTimelineEvent } from '../../native-chat/agent-session-timeline/provider-timeline-event'
import { AcpTimelineTranslator } from './acp-timeline-translator'

function runUpdates(updates: readonly Record<string, unknown>[]) {
  const overlay = new AcpHistoryJournalOverlay()
  const translator = new AcpTimelineTranslator({
    sessionId: 'sess-1',
    dialect: ANTIGRAVITY_ACP_DIALECT
  })
  const assembler = createProviderTimelineAssembler({
    sink: overlay.sink,
    sessionId: 'chat-1',
    agent: 'antigravity',
    generation: 'gen-1',
    namespace: 'sess-1',
    schedule: () => () => {}
  })
  const apply = (events: readonly ProviderTimelineEvent[]) => {
    for (const event of events) {
      const result = assembler.apply(event)
      expect(result.admission.accepted).toBe(true)
      expect(result.dropped).toBeUndefined()
    }
  }
  apply(translator.openPrompt('prompt-1', 1).events)
  updates.forEach((update, index) => {
    apply(translator.notification('session/update', { sessionId: 'sess-1', update }, index + 2))
  })
  apply(translator.promptResult('prompt-1', { stopReason: 'end_turn' }, updates.length + 2))
  assembler.dispose()
  return overlay.created().flatMap((item) => {
    if (item.body.kind !== 'message') {
      return []
    }
    const text = item.body.blocks
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
    return [{ role: item.body.role, text }]
  })
}

describe('ACP anonymous text channel transitions', () => {
  it('starts a new assistant message after an intervening reasoning chunk instead of concatenating', () => {
    const messages = runUpdates([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'First reply.' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking next.' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Second reply.' } }
    ])

    expect(messages).toEqual([
      { role: 'assistant', text: 'First reply.' },
      { role: 'reasoning', text: 'Thinking next.' },
      { role: 'assistant', text: 'Second reply.' }
    ])
  })

  it('starts a new reasoning message after an intervening assistant chunk', () => {
    const messages = runUpdates([
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thought one.' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Answer one.' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thought two.' } }
    ])

    expect(messages).toEqual([
      { role: 'reasoning', text: 'Thought one.' },
      { role: 'assistant', text: 'Answer one.' },
      { role: 'reasoning', text: 'Thought two.' }
    ])
  })

  it('still coalesces consecutive anonymous chunks on the same channel into one message', () => {
    const messages = runUpdates([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world.' } }
    ])

    expect(messages).toEqual([{ role: 'assistant', text: 'Hello world.' }])
  })

  it('keeps named messages with messageId keyed by id and channel', () => {
    const messages = runUpdates([
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'Part 1 ' }
      },
      {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'Thought.' }
      },
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'Part 2' }
      }
    ])

    expect(messages).toEqual([
      { role: 'assistant', text: 'Part 1 Part 2' },
      { role: 'reasoning', text: 'Thought.' }
    ])
  })
})
