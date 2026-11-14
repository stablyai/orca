import { expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

it('keeps each committed voice turn once, including speech the voice answered itself', () => {
  const rows = new Map<string, AgentJournalItemBody>()
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => rows.set(agentJournalItemKey(identity), body),
    appendTombstone: () => {},
    publish: () => {}
  }
  const translator = createCodexJournalTranslator({ sink })
  const completed = (id: string, role: string, text: string) =>
    translator.handle({
      type: 'notification',
      sessionId: 'session-1',
      threadId: 'thread-1',
      method: 'thread/realtime/item/completed',
      params: {
        threadId: 'thread-1',
        item: { id, realtimeSessionId: 'voice-1', type: 'transcriptSegment', role, text }
      }
    })

  completed('rt-1', 'user', 'Should the cache be write-through?')
  completed('rt-2', 'assistant', 'For this service, yes: reads must stay fresh.')
  // A retried notification for the same item rewrites its row.
  completed('rt-2', 'assistant', 'For this service, yes: reads must stay fresh.')

  expect([...rows.values()]).toEqual([
    {
      kind: 'status',
      text: 'Should the cache be write-through?',
      presentation: 'voice-transcript-user'
    },
    {
      kind: 'status',
      text: 'For this service, yes: reads must stay fresh.',
      presentation: 'voice-transcript-voice'
    }
  ])
})
