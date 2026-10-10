import { afterEach, describe, expect, it } from 'vitest'
import { isBackgroundTaskBlock, isSubagentGroupBlock } from '../../shared/native-chat-types'
import {
  closeProviderTimelineRigs,
  providerItemId
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { AcpStructuredLane } from './acp-structured-lane'
import { GROK_ACP_DIALECT } from './acp-dialects/grok-dialect'
import { openAcpFixtureRig } from './acp-timeline-fixture.test-support'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'

afterEach(closeProviderTimelineRigs)

type Fixture = Awaited<ReturnType<typeof openAcpFixtureRig>>

function notify(fixture: Fixture, update: Record<string, unknown>, at: number) {
  fixture.apply(
    fixture
      .lane()
      .notification('_x.ai/session_notification', { sessionId: 'session-1', update }, at)
  )
}

function openTurn(fixture: Fixture, id: string, at: number) {
  const lane = fixture.lane()
  fixture.apply(lane.openPrompt(id, at).events)
  fixture.apply(
    lane.notification(
      '_x.ai/queue/changed',
      { sessionId: 'session-1', runningPromptId: `prompt:${id}` },
      at
    )
  )
}

function spawn(fixture: Fixture, id: string, turn: string, at: number) {
  notify(
    fixture,
    {
      sessionUpdate: 'subagent_spawned',
      subagent_id: id,
      parent_prompt_id: `prompt:${turn}`,
      description: 'Original label'
    },
    at
  )
}

function laterGroups(fixture: Fixture, settled: boolean) {
  for (let index = 1; index <= 33; index++) {
    openTurn(fixture, `later-${index}`, 100 + index * 3)
    spawn(fixture, `child-${index}`, `later-${index}`, 101 + index * 3)
    if (settled) {
      notify(
        fixture,
        {
          sessionUpdate: 'subagent_finished',
          subagent_id: `child-${index}`,
          status: 'completed'
        },
        102 + index * 3
      )
    }
    fixture.apply(
      fixture.lane().promptResult(`later-${index}`, { stopReason: 'end_turn' }, 103 + index * 3)
    )
  }
}

async function roster(fixture: Fixture) {
  return (await fixture.rig.rows()).flatMap((row) =>
    row.body.kind === 'message'
      ? row.body.blocks.filter(isSubagentGroupBlock).map((group) => ({ row, group }))
      : []
  )
}

async function original(fixture: Fixture) {
  return (await roster(fixture)).find(({ group }) => group.groupId === 'prompt:original')
}

function toolResult(fixture: Fixture, kind: 'output' | 'kill', at: number) {
  fixture.apply(
    fixture.lane().notification(
      'session/update',
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'tool_call',
          title: kind === 'output' ? 'get_command_or_subagent_output' : 'kill_command_or_subagent',
          toolCallId: `tool-${kind}`,
          status: 'completed',
          rawInput: { task_ids: ['old'] },
          ...(kind === 'output'
            ? {
                rawOutput: {
                  type: 'TaskOutput',
                  Result: {
                    task_id: 'old',
                    command: '[subagent:explore] Original label',
                    status: 'completed',
                    output: 'Original answer'
                  }
                }
              }
            : {}),
          _meta: {
            'x.ai/tool': {
              name:
                kind === 'output' ? 'get_command_or_subagent_output' : 'kill_command_or_subagent'
            }
          }
        }
      },
      at
    )
  )
}

describe('Grok roster ownership after more than 32 spawning groups', () => {
  it.each([false, true])(
    'finishes the original durable row with siblings and reply when later groups settled=%s',
    async (settled) => {
      const fixture = await openAcpFixtureRig()
      openTurn(fixture, 'original', 1)
      spawn(fixture, 'old', 'original', 2)
      spawn(fixture, 'sibling', 'original', 3)
      notify(
        fixture,
        { sessionUpdate: 'subagent_finished', subagent_id: 'sibling', status: 'completed' },
        4
      )
      fixture.apply(fixture.lane().promptResult('original', { stopReason: 'end_turn' }, 5))
      const before = await original(fixture)
      expect(before).toBeDefined()
      laterGroups(fixture, settled)
      openTurn(fixture, 'current', 300)
      notify(
        fixture,
        {
          sessionUpdate: 'subagent_finished',
          subagent_id: 'old',
          status: 'completed',
          output: 'Original answer',
          tokens_used: 12
        },
        301
      )
      const after = await original(fixture)
      expect(after?.row.itemId).toBe(before?.row.itemId)
      expect(after?.row.turnScope).toEqual(before?.row.turnScope)
      expect(after?.group.agents).toEqual([
        {
          id: 'old',
          label: 'Original label',
          startedAt: 2,
          settledAt: 301,
          state: 'completed',
          tokens: 12
        },
        { id: 'sibling', label: 'Original label 2', startedAt: 3, settledAt: 4, state: 'completed' }
      ])
      expect(
        (await roster(fixture)).flatMap(({ group }) =>
          group.agents.filter((entry) => entry.id === 'old')
        )
      ).toHaveLength(1)
      const reply = (await fixture.rig.rows()).find((row) => row.agentId === 'old')
      expect(reply?.turnScope).toEqual(before?.row.turnScope)
      expect(reply?.body).toMatchObject({
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'Original answer' }]
      })
    }
  )

  it.each(['output', 'kill'] as const)(
    'a known-only %s still reaches the original child',
    async (kind) => {
      const fixture = await openAcpFixtureRig()
      openTurn(fixture, 'original', 1)
      spawn(fixture, 'old', 'original', 2)
      fixture.apply(fixture.lane().promptResult('original', { stopReason: 'end_turn' }, 3))
      const before = await original(fixture)
      laterGroups(fixture, false)
      openTurn(fixture, 'current', 300)
      toolResult(fixture, kind, 301)
      const after = await original(fixture)
      expect(after?.row.itemId).toBe(before?.row.itemId)
      expect(after?.group.agents).toEqual([
        {
          id: 'old',
          label: 'Original label',
          startedAt: 2,
          settledAt: 301,
          state: kind === 'output' ? 'completed' : 'stopped'
        }
      ])
      const rows = await fixture.rig.rows()
      expect(
        rows.flatMap((row) =>
          row.body.kind === 'message' ? row.body.blocks.filter(isBackgroundTaskBlock) : []
        )
      ).toEqual([])
      expect(rows.filter((row) => row.agentId === 'old')).toHaveLength(kind === 'output' ? 1 : 0)
    }
  )

  it('drops late progress, repeated spawn and finish for a stopped child after its settled group is evicted', async () => {
    const fixture = await openAcpFixtureRig()
    openTurn(fixture, 'original', 1)
    spawn(fixture, 'old', 'original', 2)
    toolResult(fixture, 'kill', 3)
    fixture.apply(fixture.lane().promptResult('original', { stopReason: 'end_turn' }, 4))
    const before = await original(fixture)
    laterGroups(fixture, true)
    openTurn(fixture, 'current', 300)
    notify(fixture, { sessionUpdate: 'subagent_progress', subagent_id: 'old', tokens_used: 9 }, 301)
    spawn(fixture, 'old', 'original', 302)
    notify(
      fixture,
      {
        sessionUpdate: 'subagent_finished',
        subagent_id: 'old',
        status: 'completed',
        output: 'Late answer'
      },
      303
    )
    expect(await original(fixture)).toEqual(before)
    expect(
      (await roster(fixture)).flatMap(({ group }) =>
        group.agents.filter((entry) => entry.id === 'old')
      )
    ).toHaveLength(1)
    expect((await fixture.rig.rows()).filter((row) => row.agentId === 'old')).toEqual([])
  })

  it('lane disposal ends in-memory ownership while the journal settles a disconnected producer as unverifiable', async () => {
    const fixture = await openAcpFixtureRig()
    const lane = new AcpStructuredLane({
      sink: fixture.rig.sink,
      sessionId: 'session-timeline',
      agent: 'grok',
      agentName: 'Grok',
      generation: 'gen-1',
      providerSessionId: 'session-1',
      dialect: GROK_ACP_DIALECT,
      logger: recordingStructuredAgentSessionLogger().logger,
      onInputAccepted: () => {},
      onFailed: (reason) => {
        throw new Error(reason)
      }
    })
    lane.apply(
      lane.translator.notification(
        '_x.ai/session_notification',
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'subagent_spawned',
            subagent_id: 'old',
            description: 'Original label'
          }
        },
        1
      )
    )
    lane.apply([{ type: 'session.ended', verdict: { state: 'unverifiable' } }])
    lane.flush()
    lane.dispose()
    const events = lane.translator.notification(
      '_x.ai/session_notification',
      {
        sessionId: 'session-1',
        update: { sessionUpdate: 'subagent_progress', subagent_id: 'old', tokens_used: 9 }
      },
      2
    )
    expect(events).toEqual([])
    const row = await fixture.rig.row(
      providerItemId('item', 'subagents:thread', { namespace: 'session-1', thread: 'session-1' })
    )
    expect(
      row?.body.kind === 'message' &&
        row.body.blocks.filter(isSubagentGroupBlock).flatMap((group) => group.agents)
    ).toMatchObject([{ id: 'old', state: 'unverifiable' }])
  })
})
