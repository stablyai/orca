import { expect, it } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session/lifecycle/agent-session-mutation-envelope'
import {
  claudeFrame as frame,
  claudeWasSent as wrote
} from '../../../../claude/structured/claude-structured-session-test-support'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  CALLER,
  declareClaudeCapabilities,
  fixture
} from './structured-agent-session-claude-stop-contract-test-fixture'
import { eventually, openTurn } from './structured-agent-session-claude-stop-contract-test-actions'

declareClaudeCapabilities()

function conversationCommand(command: 'clear' | 'compact') {
  return fixture.host.conversationCommand(CALLER, {
    command,
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: fixture.store.getRecord(SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.conversationCommand',
        sessionId: SESSION,
        fields: { command }
      })
    }
  })
}

// Frames from Claude Code 2.1.323 launching a background subagent, trimmed.
it('compacts a Claude chat while its background subagent runs, as Claude does', async () => {
  const connection = fixture.claude.connections[0]!
  await openTurn(connection, 'Start a subagent.')
  frame(connection, {
    type: 'assistant',
    uuid: 'agent-call',
    parent_tool_use_id: null,
    message: {
      id: 'msg-agent',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu-agent',
          name: 'Agent',
          input: { description: 'probe subagent', prompt: 'Look around', run_in_background: true }
        }
      ]
    }
  })
  frame(connection, {
    type: 'system',
    subtype: 'background_tasks_changed',
    uuid: 'tasks-changed',
    tasks: [
      {
        task_id: 'task-agent',
        task_type: 'local_agent',
        subagent_type: 'general-purpose',
        description: 'probe subagent'
      }
    ]
  })
  frame(connection, {
    type: 'system',
    subtype: 'task_started',
    uuid: 'task-started',
    task_id: 'task-agent',
    tool_use_id: 'toolu-agent',
    description: 'probe subagent',
    is_backgrounded: true,
    task_type: 'local_agent'
  })
  frame(connection, {
    type: 'user',
    uuid: 'agent-launched',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu-agent', content: 'Async agent launched.' }
      ]
    }
  })
  frame(connection, { type: 'result', subtype: 'success', is_error: false, uuid: 'turn-end' })
  await fixture.host.flushStreamedEvents(SESSION)
  await eventually(() =>
    expect(fixture.host.readStatusSummary(SESSION)?.status).not.toBe('working')
  )

  // /clear stops the agent, which would end the subagent with it.
  expect(await conversationCommand('clear')).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'backgroundTasksRunning' } }
  })
  expect(await conversationCommand('compact')).toMatchObject({ ok: true })
  await eventually(() => expect(wrote(connection, '/compact')).toBe(true))
})
