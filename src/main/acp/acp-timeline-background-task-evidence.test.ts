import { afterEach, describe, expect, it } from 'vitest'
import { backgroundTaskFallbackText } from '../../shared/native-chat-background-task-row'
import { isBackgroundTaskBlock } from '../../shared/native-chat-types'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { ToolCallUpdate } from './generated/acp-protocol.generated'
import { openAcpFixtureRig, readAcpFixture } from './acp-timeline-fixture.test-support'

afterEach(closeProviderTimelineRigs)

const taskId = '01a10366-1e7f-7191-bcd1-fac24585851f'
type Fixture = Awaited<ReturnType<typeof openAcpFixtureRig>>

async function taskRows(fixture: Fixture) {
  return (await fixture.rig.rows()).flatMap((row) => {
    const block =
      row.body.kind === 'message' ? row.body.blocks.find(isBackgroundTaskBlock) : undefined
    return block ? [{ row, block }] : []
  })
}

async function launch(fixture: Fixture) {
  const frames = await readAcpFixture('s6-background')
  const completion = frames.findIndex((frame) => frame.message.method === '_x.ai/task_completed')
  expect(completion).toBeGreaterThan(0)
  await fixture.feed(frames.slice(0, completion))
  return frames.slice(completion)
}

function tool(fixture: Fixture, update: ToolCallUpdate, replay = false) {
  const events = fixture.lane().notification(
    'session/update',
    {
      sessionId: 'session-1',
      _meta: { promptId: replay ? 'historic-turn' : 'kill-turn', isReplay: replay },
      update: { sessionUpdate: 'tool_call_update', ...update }
    },
    2000
  )
  for (const event of events) {
    expect(fixture.rig.assembler.apply(event).admission, update.toolCallId).toMatchObject({
      accepted: true
    })
  }
}

function taskNotice(fixture: Fixture, id: string, replay = false, completed = false) {
  fixture.apply(
    fixture.lane().notification(
      completed ? '_x.ai/task_completed' : '_x.ai/task_backgrounded',
      {
        sessionId: 'session-1',
        _meta: { isReplay: replay },
        update: completed
          ? { sessionUpdate: 'task_completed', task_snapshot: { task_id: id, exit_code: 0 } }
          : { sessionUpdate: 'task_backgrounded', task_id: id, command: 'sleep 99' }
      },
      2001
    )
  )
}

describe('background task outcome evidence', () => {
  it('SF1 keeps multiline stdout out of the task sentence and preserves the description across frames', async () => {
    const fixture = await openAcpFixtureRig()
    await launch(fixture)
    const output = `PASS a.test.js\nPASS b.test.js\n${'log line\n'.repeat(3000)}`
    fixture.apply(
      fixture.lane().notification(
        '_x.ai/task_completed',
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'task_completed',
            task_snapshot: {
              task_id: taskId,
              command: 'npm test',
              output,
              exit_code: 0
            }
          }
        },
        3000
      )
    )
    const [task] = await taskRows(fixture)
    expect(task?.block).toMatchObject({
      state: 'done',
      label: 'Sleep then write bg-marker.txt',
      summary: ''
    })
    expect(task && backgroundTaskFallbackText(task.block)).toBe(
      'Background command "Sleep then write bg-marker.txt" finished'
    )
    expect(task?.row.body).toMatchObject({
      blocks: [
        { type: 'text', text: 'Background command "Sleep then write bg-marker.txt" finished' },
        expect.objectContaining({ type: 'background-task', state: 'done' })
      ]
    })
    expect(JSON.stringify(task?.row.body)).not.toContain('PASS a.test.js')
  })

  it('uses the command when the provider never gives a description', async () => {
    const fixture = await openAcpFixtureRig()
    taskNotice(fixture, 'unnamed')
    taskNotice(fixture, 'unnamed', false, true)
    const [task] = await taskRows(fixture)
    expect(task && backgroundTaskFallbackText(task.block)).toBe(
      'Background command "sleep 99" finished'
    )
  })

  it('joins the captured task and queue notices into one completed row beside its launch tool', async () => {
    const fixture = await openAcpFixtureRig()
    const tail = await launch(fixture)
    const [before] = await taskRows(fixture)
    expect(before?.block.state).toBe('working')
    await fixture.feed(tail)
    const [after] = await taskRows(fixture)
    expect(await taskRows(fixture)).toHaveLength(1)
    expect(after?.row.itemId).toBe(before?.row.itemId)
    expect(after?.row.turnScope).toEqual(before?.row.turnScope)
    expect(after?.block).toMatchObject({
      state: 'done',
      label: 'Sleep then write bg-marker.txt',
      parentToolUseId: 'call-1'
    })
    fixture.apply([{ type: 'session.ended', verdict: { state: 'unverifiable' } }])
    expect((await taskRows(fixture))[0]?.block.state).toBe('done')
  })

  it.each(['partial', 'eviction'] as const)(
    'SF2 settles named tasks on a completed kill call after %s',
    async (boundary) => {
      const fixture = await openAcpFixtureRig()
      await launch(fixture)
      taskNotice(fixture, 'other-task')
      const [before] = await taskRows(fixture)
      tool(fixture, {
        toolCallId: 'kill-1',
        status: 'in_progress',
        _meta: { 'x.ai/tool': { name: 'kill_command_or_subagent' } },
        rawInput: { task_id: taskId, task_ids: [taskId, 'other-task'] }
      })
      await fixture.rig.rows()
      if (boundary === 'eviction') {
        for (let index = 0; index < 200; index += 1) {
          // Pressure only the translator's snapshots: settled ones go first, the running call stays.
          fixture.lane().notification(
            'session/update',
            {
              sessionId: 'session-1',
              _meta: { promptId: 'kill-turn' },
              update: {
                sessionUpdate: 'tool_call',
                title: 'Read file',
                toolCallId: `unrelated-${index}`,
                status: 'completed',
                name: 'read_file',
                rawInput: { content: 'x'.repeat(40000) },
                rawOutput: 'y'.repeat(40000)
              }
            },
            2000
          )
        }
        await fixture.rig.rows()
      }
      tool(fixture, { toolCallId: 'kill-1', status: 'completed' })
      const tasks = await taskRows(fixture)
      expect(tasks.map((task) => task.block.state)).toEqual(['idle', 'idle'])
      expect(tasks[0]?.row.itemId).toBe(before?.row.itemId)
      expect(tasks[0]?.row.turnScope).toEqual(before?.row.turnScope)
      expect(tasks[0] && backgroundTaskFallbackText(tasks[0].block)).toBe(
        'Background command "Sleep then write bg-marker.txt" was stopped'
      )
      taskNotice(fixture, taskId)
      taskNotice(fixture, taskId, false, true)
      expect((await taskRows(fixture))[0]?.block.state).toBe('idle')
    }
  )

  it.each(['pending', 'in_progress', 'failed'] as const)(
    'does not infer a stop from a %s kill call',
    async (status) => {
      const fixture = await openAcpFixtureRig()
      await launch(fixture)
      tool(fixture, {
        toolCallId: 'kill-1',
        name: 'kill_command_or_subagent',
        status,
        rawInput: { task_id: taskId }
      })
      expect((await taskRows(fixture))[0]?.block.state).toBe('working')
    }
  )

  it.each(['launch', 'notification'] as const)(
    'SF3 drops replayed %s evidence during load and accepts a later completion',
    async (source) => {
      const fixture = await openAcpFixtureRig()
      fixture.lane().beginLoad()
      if (source === 'launch') {
        tool(
          fixture,
          {
            toolCallId: 'historic-tool',
            status: 'completed',
            rawInput: { description: 'Historical task' },
            rawOutput: {
              type: 'BackgroundTaskStarted',
              task_id: taskId,
              task_type: 'bash',
              command: 'sleep 99'
            }
          },
          true
        )
      } else {
        // Unmarked: a task notice during a load is history too.
        taskNotice(fixture, taskId)
      }
      fixture.finishLoad()
      expect(await taskRows(fixture)).toEqual([])
      taskNotice(fixture, taskId, false, true)
      expect((await taskRows(fixture))[0]?.block.state).toBe('done')
    }
  )
})
