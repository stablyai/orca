import { afterEach, describe, expect, it } from 'vitest'
import { backgroundTaskFallbackText } from '../../shared/native-chat-background-task-row'
import { deriveNativeChatRowContent } from '../../shared/native-chat-row-content'
import { isBackgroundTaskBlock } from '../../shared/native-chat-types'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpFixtureRig, readAcpFixture } from './acp-timeline-fixture.test-support'

afterEach(closeProviderTimelineRigs)

const taskId = '01a10366-1e7f-7191-bcd1-fac24585851f'

async function runningFrames() {
  return (await readAcpFixture('s6-background')).filter(
    (frame) => frame.message.method !== '_x.ai/task_completed'
  )
}

async function taskRows(fixture: Awaited<ReturnType<typeof openAcpFixtureRig>>) {
  return (await fixture.rig.rows()).flatMap((row) => {
    if (row.body.kind !== 'message') {
      return []
    }
    const block = row.body.blocks.find(isBackgroundTaskBlock)
    return block ? [{ row, block }] : []
  })
}

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

type TaskCompletionEvidence = {
  exit_code?: number | null
  error?: string
  output?: string
  signal?: string | number | null
  explicitly_killed?: boolean
}

function completed(snapshot: TaskCompletionEvidence = { exit_code: 0 }) {
  return {
    sessionId: 'session-1',
    update: { sessionUpdate: 'task_completed', task_snapshot: { task_id: taskId, ...snapshot } }
  }
}

describe('Grok background tasks through the shared timeline', () => {
  it('renders the recorded task outside turn settlement and marks it unverifiable when the session ends', async () => {
    const fixture = await openAcpFixtureRig()
    await fixture.feed(await runningFrames())
    const [before] = await taskRows(fixture)
    expect(before?.block).toMatchObject({
      taskId,
      kind: 'command',
      state: 'working',
      parentToolUseId: 'call-1',
      outputFile: '/workspace/file-1'
    })
    expect(before?.row.turnScope?.kind).toBe('turn')
    expect((await fixture.rig.turns()).map((turn) => turn.state)).toEqual([
      'completed',
      'completed'
    ])
    expect(
      (await fixture.rig.rows()).find((row) => row.body.kind === 'tool-call')?.body
    ).toMatchObject({ state: 'completed' })
    if (!before || before.row.body.kind !== 'message') {
      throw new Error('Missing background-task row')
    }
    const render = deriveNativeChatRowContent(before.row.body.blocks)
    expect(render.backgroundTasks).toEqual([before.block])
    expect(render.prose).toEqual([])

    fixture.apply([{ type: 'session.ended', verdict: { state: 'unverifiable' } }])
    const [after] = await taskRows(fixture)
    expect(after?.row.itemId).toBe(before.row.itemId)
    expect(after?.block.state).toBe('unverifiable')
    expect(after?.row.body).toMatchObject({
      blocks: [{ type: 'text', text: backgroundTaskFallbackText(after!.block) }, after!.block]
    })
  })

  it.each(['x.ai/', '_x.ai/'])(
    'joins %s task notifications and the tool result into one row that keeps its origin',
    async (prefix) => {
      const fixture = await openAcpFixtureRig()
      const frames = await runningFrames()
      await fixture.feed(frames.slice(0, 5))
      fixture.apply(fixture.lane().notification(`${prefix}task_backgrounded`, started(), 1010))
      await fixture.feed(frames.slice(5))
      const [before] = await taskRows(fixture)
      expect(await taskRows(fixture)).toHaveLength(1)
      expect(before?.block.label).toBe('Sleep then write bg-marker.txt')
      fixture.apply(
        fixture
          .lane()
          .notification(
            `${prefix}task_completed`,
            completed({ exit_code: 0, output: 'Finished' }),
            2000
          )
      )
      const [after] = await taskRows(fixture)
      expect(after?.row.itemId).toBe(before?.row.itemId)
      expect(after?.row.turnScope).toEqual(before?.row.turnScope)
      expect(after?.block).toMatchObject({
        state: 'done',
        summary: '',
        label: before?.block.label,
        parentToolUseId: 'call-1'
      })
      expect(await fixture.rig.turns()).toHaveLength(2)
      fixture.apply(fixture.lane().notification(`${prefix}task_backgrounded`, started(), 2001))
      expect((await taskRows(fixture))[0]?.block.state).toBe('done')
    }
  )

  it.each([
    [{ exit_code: 2, error: 'Command failed' }, 'blocked'],
    [{ exit_code: null, error: 'Task failed' }, 'blocked'],
    [{ exit_code: null, signal: 'SIGTERM' }, 'blocked'],
    [{ exit_code: null, explicitly_killed: true }, 'idle'],
    [{ exit_code: null }, 'done']
  ] as const)(
    'preserves explicit task completion and the provider outcome %j',
    async (snapshot, state) => {
      const fixture = await openAcpFixtureRig()
      await fixture.feed(await runningFrames())
      fixture.apply(fixture.lane().notification('x.ai/task_completed', completed(snapshot), 2000))
      expect((await taskRows(fixture))[0]?.block.state).toBe(state)
    }
  )

  it('keeps the row and placement of a task whose snapshot the bound evicted', async () => {
    const fixture = await openAcpFixtureRig()
    await fixture.feed(await runningFrames())
    const [before] = await taskRows(fixture)
    for (let index = 0; index < 130; index += 1) {
      fixture.apply(
        fixture
          .lane()
          .notification('x.ai/task_backgrounded', started(`task-${index}`), 1500 + index)
      )
    }
    fixture.apply(fixture.lane().notification('x.ai/task_completed', completed(), 2000))
    const original = (await taskRows(fixture)).find((task) => task.block.taskId === taskId)
    expect(original?.row.itemId).toBe(before?.row.itemId)
    expect(original?.row.turnScope).toEqual(before?.row.turnScope)
    expect(original?.block.state).toBe('done')
  })

  it('places a first task notice beside its original tool after its turn ended and another began', async () => {
    const fixture = await openAcpFixtureRig()
    await fixture.feed((await runningFrames()).slice(0, 5))
    fixture.apply(
      fixture.lane().notification(
        'session/update',
        {
          sessionId: 'session-1',
          update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed' }
        },
        1200
      )
    )
    fixture.apply(fixture.lane().promptResult('p1:3', { stopReason: 'end_turn' }, 1300))
    const original = (await fixture.rig.rows()).find((row) => row.body.kind === 'tool-call')
    fixture.apply(fixture.lane().openPrompt('next', 1400).events)
    fixture.apply(
      fixture.lane().notification(
        'session/update',
        {
          sessionId: 'session-1',
          _meta: { promptId: 'prompt:next' },
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Next reply' }
          }
        },
        1500
      )
    )
    fixture.apply(fixture.lane().notification('x.ai/task_backgrounded', started(), 1600))
    expect((await taskRows(fixture))[0]?.row.turnScope).toEqual(original?.turnScope)
    expect((await fixture.rig.turns()).map((turn) => turn.state)).toEqual(['completed', 'running'])
    fixture.apply(fixture.lane().notification('x.ai/task_completed', completed(), 1700))
    expect((await taskRows(fixture))[0]?.block.state).toBe('done')
    expect((await fixture.rig.turns())[1]?.state).toBe('running')
  })

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
