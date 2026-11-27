import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionItemAppendOptions } from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { ClaudeChildWorkDecoder } from '../child-work/claude-child-work-decoder'
import { createClaudeJournalTranslator } from '../structured/journal/claude-structured-journal-translation'

// Shapes Claude Code 2.1.330+ emits over stream-json for a foreground `/code-review` fork.
const TASK = 'a5ae968a7e49ce6de'
const SESSION = '5913d71f-9029-401e-884e-b83f97e21bf2'
const flags = { skip_transcript: true, ambient: true }
const started = {
  type: 'system',
  subtype: 'task_started',
  task_id: TASK,
  description: '/code-review',
  subagent_type: 'general-purpose',
  is_backgrounded: false,
  spawn_depth: 1,
  task_type: 'local_agent',
  session_id: SESSION,
  ...flags
}
const notification = {
  type: 'system',
  subtype: 'task_notification',
  task_id: TASK,
  status: 'completed',
  summary: '/code-review',
  session_id: SESSION,
  ...flags
}
// Claude holds the fork's messages until the turn ends, then forwards them named after the command.
const forwarded = {
  parent_tool_use_id: 'forked-command-code-review',
  agent_id: TASK,
  session_id: SESSION,
  subagent_type: 'general-purpose',
  task_description: '/code-review'
}
const toolCall = {
  type: 'assistant',
  uuid: 'u1',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]
  },
  ...forwarded
}
const toolResult = {
  type: 'user',
  uuid: 'u2',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ...forwarded
}

function run(frames: Record<string, unknown>[]) {
  const items = new Map<
    string,
    { body: AgentJournalItemBody; options: StructuredAgentSessionItemAppendOptions }
  >()
  const journal = createClaudeJournalTranslator({
    sink: {
      appendItem: (identity, body, options) => {
        items.set(agentJournalItemKey(identity), { body, options })
      },
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  const childWork = new ClaudeChildWorkDecoder(journal.taskInvocations)
  const evidence = frames.flatMap((message) => {
    childWork.observe(message)
    journal.handle({ type: 'message', sessionId: 'orca', observedAt: 1_000, message })
    return childWork.drain(1_000)
  })
  return { items, evidence }
}

function toolRows(items: ReturnType<typeof run>['items']) {
  return [...items.values()].filter(({ body }) => body.kind === 'tool-call')
}

describe('Claude forked slash command subagent', () => {
  it('shows the fork while it runs and files its forwarded tool calls under it', () => {
    const { items, evidence } = run([started, notification, toolCall, toolResult])

    expect(evidence.map((edge) => edge.type)).toEqual(['live', 'ended'])
    const tools = toolRows(items)
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ body: { state: 'completed' }, options: { agentId: TASK } })
  })

  it('files the tool calls under the fork when its display name differs from the command name', () => {
    const renamed = { parent_tool_use_id: 'forked-command-review-it' }
    const { items } = run([
      { ...started, description: '/Review It' },
      { ...notification, summary: '/Review It' },
      { ...toolCall, ...renamed },
      { ...toolResult, ...renamed }
    ])

    expect(toolRows(items).map(({ options }) => options.agentId)).toEqual([TASK])
  })
})
