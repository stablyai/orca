import { afterEach, describe, expect, it } from 'vitest'
import { isBackgroundTaskBlock } from '../../shared/native-chat-types'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpFixtureRig } from './acp-timeline-fixture.test-support'

afterEach(closeProviderTimelineRigs)

describe('background task results', () => {
  it.each([
    ['running', undefined, 'working'],
    ['completed', 0, 'done'],
    ['completed', undefined, 'done'],
    ['failed', 1, 'blocked'],
    ['stopped', undefined, 'idle'],
    ['unknown', undefined, 'working']
  ] as const)(
    'settles a task from a TaskOutput result with status %s and exit code %s',
    async (status, exitCode, state) => {
      const fixture = await openAcpFixtureRig()
      const lane = fixture.lane()
      for (const [index, rawOutput] of [
        { type: 'BackgroundTaskStarted', task_id: 'task-1', command: 'npm test' },
        {
          type: 'TaskOutput',
          Result: {
            task_id: 'task-1',
            command: 'npm test',
            status,
            exit_code: exitCode,
            output: 'PASS a.test.js\nPASS b.test.js\n'
          }
        }
      ].entries()) {
        fixture.apply(
          lane.notification(
            'session/update',
            {
              sessionId: 'session-1',
              _meta: { promptId: 'task-turn' },
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: `tool-${index}`,
                status: 'completed',
                rawOutput
              }
            },
            1000 + index
          )
        )
      }
      const tasks = (await fixture.rig.rows()).flatMap((row) =>
        row.body.kind === 'message' ? row.body.blocks.filter(isBackgroundTaskBlock) : []
      )
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({ state, label: 'npm test' })
      expect(tasks[0]?.summary ?? '').not.toContain('PASS')
    }
  )

  it('uses each structured kill result rather than inferring a stop for unsuccessful targets', async () => {
    const fixture = await openAcpFixtureRig()
    const lane = fixture.lane()
    for (const id of ['killed-task', 'kept-task']) {
      fixture.apply(
        lane.notification(
          '_x.ai/task_backgrounded',
          {
            sessionId: 'session-1',
            update: { sessionUpdate: 'task_backgrounded', task_id: id, command: 'sleep 99' }
          },
          1000
        )
      )
    }
    fixture.apply(
      lane.notification(
        'session/update',
        {
          sessionId: 'session-1',
          _meta: { promptId: 'kill-turn' },
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'kill-1',
            status: 'completed',
            name: 'kill_command_or_subagent',
            rawInput: { task_ids: ['killed-task', 'kept-task'] },
            rawOutput: {
              type: 'KillTask',
              MultiResult: {
                results: [
                  { task_id: 'killed-task', outcome: 'killed' },
                  { task_id: 'kept-task', outcome: 'not_killed' }
                ]
              }
            }
          }
        },
        1100
      )
    )
    const tasks = (await fixture.rig.rows()).flatMap((row) =>
      row.body.kind === 'message' ? row.body.blocks.filter(isBackgroundTaskBlock) : []
    )
    expect(tasks.map((task) => [task.taskId, task.state])).toEqual([
      ['killed-task', 'idle'],
      ['kept-task', 'working']
    ])
  })
})
