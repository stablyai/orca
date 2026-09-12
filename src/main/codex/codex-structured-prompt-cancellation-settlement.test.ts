import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { CODEX_COMMAND_APPROVAL_METHOD } from './codex-structured-prompt-replies'

describe('codex structured prompt cancellation settlement', () => {
  it('retains the cancellation receipt on prompts settled by turn completion', () => {
    const bodies: AgentJournalItemBody[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: (_identity, body) => bodies.push(body),
      appendTombstone: () => undefined,
      publish: () => undefined
    }
    const translator = createCodexJournalTranslator({ sink })
    translator.handle({
      type: 'notification',
      sessionId: 'session-1',
      threadId: 'thread-1',
      method: 'turn/started',
      params: { turn: { id: 'turn-1' } }
    })
    translator.handle({
      type: 'prompt',
      sessionId: 'session-1',
      threadId: 'thread-1',
      method: CODEX_COMMAND_APPROVAL_METHOD,
      params: { turnId: 'turn-1', availableDecisions: ['accept', 'decline'] },
      codexItemId: 'command-1',
      promptKey: 'approval-1'
    })
    translator.handle({
      type: 'notification',
      sessionId: 'session-1',
      threadId: 'thread-1',
      method: 'turn/completed',
      params: { turn: { id: 'turn-1' } },
      settlementId: 'prompt-cancel:operation-1',
      resolvedBy: 'client-1',
      resolvedAt: 123
    })

    expect(bodies.findLast((body) => body.kind === 'approval')).toMatchObject({
      resolution: {
        state: 'cancelled',
        settlementId: 'prompt-cancel:operation-1',
        resolvedBy: 'client-1',
        resolvedAt: 123
      }
    })
  })
})
