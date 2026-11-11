import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'

import { openAcpFixtureRig } from './testing/acp-timeline-fixture.test-support'

afterEach(closeProviderTimelineRigs)

function texts(rows: AgentJournalRenderItem[], agentId: string) {
  return rows.flatMap((row) =>
    row.agentId === agentId && row.body.kind === 'message'
      ? row.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      : []
  )
}

const opened = () => openAcpFixtureRig(OPENCODE_ACP_DIALECT, { journalOwnership: true })

describe('OpenCode subagents through the shared timeline', () => {
  it('a reply that resumes after the subagent thinks or runs a tool keeps all of its text', async () => {
    const fixture = await opened()
    const lane = fixture.lane()
    const report = (body: Record<string, unknown>) =>
      fixture.apply(lane.notification('opencode/session/child_update', { ...CHILD, ...body }, 1000))
    report({ type: 'status', status: 'created', title: 'Helper' })
    report(chunk('agent_message_chunk', 'msg-1', 'A'))
    report(chunk('agent_thought_chunk', 'msg-1:reasoning:0', 'R'))
    report({
      type: 'update',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'session-2:t1',
        title: 'shell',
        status: 'pending'
      }
    })
    report(chunk('agent_message_chunk', 'msg-1', 'B'))
    report({ type: 'status', status: 'completed' })
    expect(texts(await fixture.rig.rows(), 'session-2')).toEqual(['AB', 'R'])
  })
})

const CHILD = {
  rootSessionId: 'session-1',
  childSessionId: 'session-2',
  parentSessionId: 'session-1'
}

function chunk(sessionUpdate: string, messageId: string, text: string) {
  return {
    type: 'update',
    update: { sessionUpdate, messageId, content: { type: 'text', text } }
  }
}
