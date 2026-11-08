import { afterEach, describe, expect, it } from 'vitest'
import { isBackgroundTaskBlock } from '../../../shared/native-chat/native-chat-types'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpFixtureRig } from './testing/acp-timeline-fixture.test-support'

afterEach(closeProviderTimelineRigs)

type Fixture = Awaited<ReturnType<typeof openAcpFixtureRig>>

async function taskBlocks(fixture: Fixture) {
  return (await fixture.rig.rows()).flatMap((row) =>
    row.body.kind === 'message' ? row.body.blocks.filter(isBackgroundTaskBlock) : []
  )
}

function notify(fixture: Fixture, method: string, update: Record<string, unknown>) {
  fixture.apply(
    fixture
      .lane()
      .notification(method, { sessionId: 'session-1', _meta: { promptId: 'turn-1' }, update }, 2000)
  )
}

describe('what a background task row says', () => {
  it('reads a monitor from its output command alone, and a named kind still wins', async () => {
    const fixture = await openAcpFixtureRig()
    notify(fixture, 'session/update', {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'read-1',
      status: 'completed',
      rawOutput: {
        type: 'TaskOutput',
        Result: { task_id: 'watch-2', command: '[monitor:tail] Tail the log', status: 'running' }
      }
    })
    expect((await taskBlocks(fixture))[0]?.kind).toBe('monitor')
    notify(fixture, '_x.ai/task_completed', {
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 'watch-2', task_type: 'bash', command: 'tail -f log', exit_code: 0 }
    })
    expect((await taskBlocks(fixture))[0]?.kind).toBe('command')
  })
})
