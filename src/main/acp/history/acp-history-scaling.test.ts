import { afterEach, expect, it } from 'vitest'

import '../../../shared/agent-session/journal/agent-session-journal-item-key'
import '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import '../../../shared/agent-session/failures/agent-session-failure'
import '../../../shared/agent-session/failures/agent-session-failure-words'
import {
  AGENT,
  SESSION,
  NAMESPACE,
  closeProviderTimelineRigs
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import '../../native-chat/agent-session-journal/projection/journal-dispatch-doubt-reasons'
import '../../native-chat/agent-session-timeline/provider-timeline-history'
import '../../native-chat/agent-session-wire/termination/testing/structured-agent-session-observed-exit.test-fixture'
import '../../native-chat/agent-session-wire/termination/structured-agent-session-unfinished-work'
import '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import '../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger-test-support'
import './acp-history-scaling-counts.test-fixture'
import './acp-history-scaling-operations.test-fixture'
import './acp-history-catch-up'
import './acp-history-catch-up.test-support'
import { acpHistoryTurns, type AcpLoadHistoryFrame } from './acp-history-replay'
import { translateHistoryTurn, type AcpHistoryScope } from './acp-history-translation'
import './acp-history-turn-matching'
import '../acp-turn-messages'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'
import '../acp-dialects/grok-dialect'
import '../../native-chat/agent-session-wire/acquisition/structured-agent-session-history-catch-up'
import '../../native-chat/agent-session-journal/writing/journal-lifecycle-mutation'

afterEach(closeProviderTimelineRigs)
const scope: AcpHistoryScope = {
  agent: AGENT,
  sessionId: SESSION,
  providerSessionId: NAMESPACE,
  identity: 'user-message-id',
  dialect: OPENCODE_ACP_DIALECT
}
const frame = (
  update: Record<string, unknown>,
  meta?: Record<string, unknown>
): AcpLoadHistoryFrame => ({
  method: 'session/update',
  params: { sessionId: NAMESPACE, update, ...(meta ? { _meta: meta } : {}) }
})
const user = (id: string, text: string) =>
  frame({ sessionUpdate: 'user_message_chunk', messageId: id, content: { type: 'text', text } })

it('imports a whole historical turn with more than 128 still-open message segments', () => {
  const frames = [user('long-turn', 'Review the repository')]
  for (let index = 0; index < 160; index += 1) {
    frames.push(
      frame({
        sessionUpdate: 'agent_message_chunk',
        messageId: `answer-${index}`,
        content: { type: 'text', text: 'Retained segment' }
      })
    )
  }
  frames.push(
    frame({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'answer-0',
      content: { type: 'text', text: ' and its late tail' }
    })
  )
  const turn = acpHistoryTurns(frames, scope.identity)[0]
  if (!turn || turn.turn === null) {
    throw new Error('Missing identified historical turn')
  }
  const items = translateHistoryTurn(scope, { ...turn, turn: turn.turn })
  const answers = items.flatMap((item) =>
    item.body.kind === 'message' && item.body.role === 'assistant' ? [item.body] : []
  )
  expect(answers).toHaveLength(160)
  expect(answers[0]).toMatchObject({
    blocks: [{ type: 'text', text: 'Retained segment and its late tail' }]
  })
})
