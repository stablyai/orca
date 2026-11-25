import { expect, it } from 'vitest'
import { chat } from '../threads/codex-thread-catch-up-contract-test-fixture'
import { projectStructuredAgentSessionMessages } from '../../../../shared/agent-session/view/structured-agent-session-message-projection'
import { readTestJournalSnapshot } from '../../../native-chat/agent-session-journal/journal-observation.test-support'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'

it('keeps policy out of the durable catch-up journal and keeps genuine owner labels after reopening', async () => {
  const c = await chat({ now: 1_800_000_000_000 })
  await c.open([
    {
      id: 'restored-turn',
      status: 'completed',
      itemsView: 'full',
      items: [
        {
          type: 'message',
          id: 'orca-policy-proof',
          role: 'developer',
          content: [{ type: 'input_text', text: 'PRIVATE_POLICY_MARKER' }]
        },
        {
          type: 'userMessage',
          id: 'owner',
          content: [{ type: 'text', text: '[Orca policy] these are my words' }]
        },
        { type: 'agentMessage', id: 'answer', text: 'Acknowledged.' }
      ]
    }
  ])
  await c.reopen()
  const snapshot = await readTestJournalSnapshot(c.journal)
  expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_POLICY_MARKER')
  const visible = projectStructuredAgentSessionMessages(snapshot.items, [], snapshot.submissions)
  expect(
    visible.filter((message) => message.role === 'user').flatMap((message) => message.blocks)
  ).toEqual([{ type: 'text', text: '[Orca policy] these are my words' }])
})

it('drops live and fallback developer items while retaining ordinary agent text', () => {
  const topics: AgentJournalItemBody[] = []
  const sessionId = 'policy-chat'
  const threadId = 'policy-thread'
  const translator = createCodexJournalTranslator({
    sink: {
      appendItem: (_identity, body) => topics.push(body),
      appendTombstone: () => {},
      publish: () => {}
    },
    sessionId,
    primaryThreadId: () => threadId
  })
  const policy = {
    type: 'message',
    id: 'orca-policy-proof',
    role: 'developer',
    content: [{ type: 'input_text', text: 'PRIVATE_POLICY_MARKER' }]
  }
  translator.handle({
    type: 'notification',
    method: 'item/completed',
    sessionId,
    threadId,
    params: { item: policy }
  })
  translator.handle({
    type: 'provider-frame',
    sessionId,
    threadId,
    kind: 'unknown-item',
    payload: { item: policy }
  })
  translator.handle({
    type: 'notification',
    method: 'item/completed',
    sessionId,
    threadId,
    params: { item: { type: 'agentMessage', id: 'answer', text: '[Orca policy] quoted task text' } }
  })
  translator.flush()
  expect(topics).toEqual([
    {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: '[Orca policy] quoted task text' }]
    }
  ])
})
