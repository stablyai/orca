import { afterEach, describe, expect, it } from 'vitest'
import { backgroundTaskFallbackText } from '../../shared/native-chat-background-task-row'
import { isBackgroundTaskBlock } from '../../shared/native-chat-types'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpFixtureRig, readAcpFixture } from './acp-timeline-fixture.test-support'

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
  it('describes a running recorded command by its description, not the start summary', async () => {
    const fixture = await openAcpFixtureRig()
    const frames = await readAcpFixture('s6-background')
    const completion = frames.findIndex((frame) => frame.message.method === '_x.ai/task_completed')
    await fixture.feed(frames.slice(0, completion))
    const rows = (await fixture.rig.rows()).filter(
      (row) => row.body.kind === 'message' && row.body.blocks.some(isBackgroundTaskBlock)
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.body).toMatchObject({
      blocks: [
        { type: 'text', text: 'Started background command "Sleep then write bg-marker.txt"' },
        expect.objectContaining({ type: 'background-task', state: 'working' })
      ]
    })
    const [task] = await taskBlocks(fixture)
    expect(task?.summary).toBeUndefined()
    expect(JSON.stringify(rows[0]?.body)).not.toContain('Background task')
  })

  it('keeps a monitor a monitor when the agent reads its output', async () => {
    const fixture = await openAcpFixtureRig()
    notify(fixture, '_x.ai/task_backgrounded', {
      sessionUpdate: 'task_backgrounded',
      task_id: 'watch-1',
      command: 'for i in 1 2 3; do echo tick $i; sleep 8; done',
      monitor_description: 'Watch three tick echoes'
    })
    notify(fixture, '_x.ai/task_completed', {
      sessionUpdate: 'task_completed',
      task_snapshot: { task_id: 'watch-1', kind: 'monitor', exit_code: 0 }
    })
    for (const [index, command] of [
      '[monitor] Watch three tick echoes',
      'for i in 1 2 3; do echo tick $i; sleep 8; done'
    ].entries()) {
      notify(fixture, 'session/update', {
        sessionUpdate: 'tool_call_update',
        toolCallId: `read-${index}`,
        status: 'completed',
        rawOutput: {
          type: 'TaskOutput',
          Result: { task_id: 'watch-1', command, status: 'completed', exit_code: 0 }
        }
      })
    }
    const [task] = await taskBlocks(fixture)
    expect(task).toMatchObject({ kind: 'monitor', state: 'done' })
    expect(task && backgroundTaskFallbackText(task)).toBe(
      'Background monitor "Watch three tick echoes" finished'
    )
  })

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
