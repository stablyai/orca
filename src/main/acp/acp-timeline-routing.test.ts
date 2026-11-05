import { afterEach, describe, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  messageText
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpFixtureRig } from './acp-timeline-fixture.test-support'
import { AcpAgentError } from './acp-errors'

const chunk = (promptId: string, text: string) => ({
  sessionId: 'session-1',
  _meta: { promptId },
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
})
const done = (promptId: string, stopReason = 'end_turn') => ({
  sessionId: 'session-1',
  update: { sessionUpdate: 'turn_completed', prompt_id: promptId, stop_reason: stopReason }
})
afterEach(closeProviderTimelineRigs)

describe('ACP exact prompt identity', () => {
  it.each(['task-completed-2', 'subagent-completed-2', 'notifications-9', 'future-wake'])(
    'opens %s independently of a queued user prompt',
    async (wake) => {
      const f = await openAcpFixtureRig()
      const lane = f.lane()
      const prompt = lane.openPrompt('c1', 1000)
      expect(prompt.events).toEqual([])
      f.apply(lane.notification('session/update', chunk(wake, 'background'), 1001))
      f.apply(lane.notification('_x.ai/session_notification', done(wake), 1002))
      f.apply(lane.notification('session/update', chunk(prompt.promptId, 'user reply'), 1003))
      f.apply(lane.notification('_x.ai/session_notification', done(prompt.promptId), 1004))
      f.apply(lane.promptResult('c1', { stopReason: 'end_turn' }, 1005))
      const rows = await f.rig.rows()
      const messages = rows.filter((row) => row.body.kind === 'message')
      expect(messages.map((row) => messageText(row.body))).toEqual(['background', 'user reply'])
      expect(messages[0]?.turnScope).not.toEqual(messages[1]?.turnScope)
      expect((await f.rig.turns()).map((turn) => turn.outcome)).toEqual(['success', 'success'])
    }
  )

  it('keeps a streaming background turn open when the user sends and scopes its permission to the tool', async () => {
    const f = await openAcpFixtureRig()
    const lane = f.lane()
    f.apply(lane.notification('session/update', chunk('background', 'first'), 1000))
    f.apply(
      lane.notification(
        'session/update',
        {
          sessionId: 'session-1',
          _meta: { promptId: 'background' },
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'bg-tool',
            title: 'Write',
            status: 'pending'
          }
        },
        1001
      )
    )
    const prompt = lane.openPrompt('c1', 1002)
    f.apply(prompt.events)
    const request = lane.request(
      'session/request_permission',
      {
        sessionId: 'session-1',
        toolCall: { toolCallId: 'bg-tool', title: 'Write' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
      },
      0
    )
    expect(request.events[0]).toMatchObject({ join: { turn: 'background' } })
    f.apply(request.events)
    f.apply(lane.notification('session/update', chunk('background', 'second'), 1003))
    f.apply(lane.notification('_x.ai/session_notification', done('background'), 1004))
    f.apply(
      lane.notification(
        '_x.ai/queue/changed',
        { sessionId: 'session-1', runningPromptId: prompt.promptId },
        1005
      )
    )
    f.apply(lane.notification('session/update', chunk(prompt.promptId, 'user reply'), 1006))
    f.apply(lane.promptResult('c1', { stopReason: 'end_turn' }, 1007))
    const rows = await f.rig.rows()
    expect(rows.find((row) => row.body.kind === 'approval')?.turnScope).toEqual(
      rows.find((row) => row.body.kind === 'tool-call')?.turnScope
    )
    expect((await f.rig.turns()).map((turn) => turn.outcome)).toEqual(['success', 'success'])
    expect(
      rows.filter((row) => row.body.kind === 'message').map((row) => messageText(row.body))
    ).toEqual(['first', 'second', 'user reply'])
  })

  it.each(['error', 'rate_limit'])(
    'reports %s before an RPC rejection and accepts the next prompt',
    async (stopReason) => {
      const f = await openAcpFixtureRig()
      const lane = f.lane()
      const prompt = lane.openPrompt('c1', 1000)
      f.apply(lane.notification('session/update', chunk(prompt.promptId, 'partial'), 1001))
      f.apply(
        lane.notification('_x.ai/session_notification', done(prompt.promptId, stopReason), 1002)
      )
      f.apply(lane.promptFailed('c1', new AcpAgentError(-32603, 'Provider rejected prompt'), 1003))
      const next = lane.openPrompt('c2', 1004)
      f.apply(next.events)
      f.apply(lane.notification('session/update', chunk(next.promptId, 'next'), 1005))
      expect(lane.promptResult('c1', { stopReason: 'end_turn' }, 1006)).toEqual([])
      f.apply(lane.promptResult('c2', { stopReason: 'end_turn' }, 1007))
      expect((await f.rig.turns()).map((turn) => turn.outcome)).toEqual(['failure', 'success'])
    }
  )

  it('settles an RPC-only failure even if the provider never streamed a frame', async () => {
    const f = await openAcpFixtureRig()
    const lane = f.lane()
    lane.openPrompt('c1', 1000)
    f.apply(lane.promptFailed('c1', new AcpAgentError(-32603, 'Rejected'), 1001))
    expect((await f.rig.turns())[0]).toMatchObject({ state: 'completed', outcome: 'failure' })
    expect(() => lane.openPrompt('c2', 1002)).not.toThrow()
  })
})
