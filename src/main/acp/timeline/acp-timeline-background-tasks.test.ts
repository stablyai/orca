import { afterEach, describe, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpFixtureRig } from './testing/acp-timeline-fixture.test-support'

afterEach(closeProviderTimelineRigs)

const taskId = '01a10366-1e7f-7191-bcd1-fac24585851f'

function started(id = taskId) {
  return {
    sessionId: 'session-1',
    update: {
      sessionUpdate: 'task_backgrounded',
      task_id: id,
      tool_call_id: 'call-1',
      command: 'sleep 15',
      description: 'Wait for the background command',
      output_file: '/workspace/output.log'
    }
  }
}

describe('Grok background tasks through the shared timeline', () => {
  it('ignores malformed, other-session and replay-only task notifications without opening turns', async () => {
    const fixture = await openAcpFixtureRig()
    for (const params of [
      { sessionId: 'session-1', update: { sessionUpdate: 'task_completed' } },
      { update: started().update },
      { ...started(), sessionId: 'other' },
      { ...started(), _meta: { isReplay: true } }
    ]) {
      fixture.apply(fixture.lane().notification('_x.ai/task_backgrounded', params, 1000))
    }
    expect(await fixture.rig.rows()).toEqual([])
  })
})
