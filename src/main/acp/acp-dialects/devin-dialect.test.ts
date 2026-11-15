import { afterEach, describe, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  NAMESPACE
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpFixtureRig } from '../timeline/testing/acp-timeline-fixture.test-support'
import { DEVIN_ACP_DIALECT } from './devin-dialect'

afterEach(() => closeProviderTimelineRigs())

const update = (rest: Record<string, unknown>) => ({
  direction: 'in' as const,
  process: 'A',
  message: {
    method: 'session/update',
    params: { sessionId: NAMESPACE, update: { ...rest } }
  }
})

describe('Devin dialect', () => {
  it('maps a subagent_started/completed child to the roster instead of an orphan tool row', async () => {
    const fixture = await openAcpFixtureRig(DEVIN_ACP_DIALECT)
    await fixture.feed([
      {
        direction: 'out',
        process: 'A',
        message: {
          id: 1,
          method: 'session/prompt',
          params: { sessionId: NAMESPACE, prompt: [] }
        }
      },
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'run_subagent:0#aa',
        title: 'Ran explore subagent Return SUBDONE',
        rawInput: { title: 'Return SUBDONE', task: 'Reply with exactly SUBDONE.' },
        _meta: { 'cognition.ai/inferenceToolName': 'run_subagent' }
      }),
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: '1833ae4d',
        status: 'in_progress',
        _meta: {
          'cognition.ai/subagent_started': {
            agentId: '1833ae4d',
            title: 'Return SUBDONE',
            task: 'Reply with exactly SUBDONE.',
            depth: 1
          }
        }
      }),
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: '1833ae4d',
        status: 'completed',
        _meta: {
          'cognition.ai/subagent_completed': {
            agentId: '1833ae4d',
            success: true,
            summary: 'SUBDONE',
            depth: 1
          }
        }
      }),
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'run_subagent:0#aa',
        status: 'completed',
        _meta: { 'cognition.ai/inferenceToolName': 'run_subagent' }
      })
    ])
    expect(fixture.subagents()).toEqual([
      expect.objectContaining({
        description: 'Return SUBDONE',
        outcome: 'succeeded'
      })
    ])
    const rows = await fixture.rig.rows()
    const calls = rows.flatMap((row) => (row.body.kind === 'tool-call' ? [row.body.callId] : []))
    expect(calls).toEqual(['run_subagent:0#aa'])
    expect(
      rows.some(
        (row) =>
          row.body.kind === 'message' &&
          row.body.blocks[0]?.type === 'text' &&
          row.body.blocks[0].text === 'SUBDONE'
      )
    ).toBe(true)
  })
})
