import { afterEach, describe, expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { isBackgroundTaskBlock } from '../../shared/native-chat-types'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
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

function record(fixture: Fixture, id: string) {
  return fixture.subagents().filter((view) => view.providerId === id)
}

async function openTurnScope(fixture: Fixture) {
  const turn = (await fixture.rig.rows()).findLast((row) => readAgentJournalTurn(row.body))
  return turn ? { kind: 'turn', turnItemId: turn.itemId } : undefined
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

describe('a Grok subagent reported on long after the turn that spawned it', () => {
  it.each([false, true])(
    'finishes the original child and files its reply under its spawn turn when 33 later turns settled=%s',
    async (settled) => {
      const fixture = await openAcpFixtureRig()
      openTurn(fixture, 'original', 1)
      const spawnScope = await openTurnScope(fixture)
      spawn(fixture, 'old', 'original', 2)
      spawn(fixture, 'sibling', 'original', 3)
      notify(
        fixture,
        { sessionUpdate: 'subagent_finished', subagent_id: 'sibling', status: 'completed' },
        4
      )
      fixture.apply(fixture.lane().promptResult('original', { stopReason: 'end_turn' }, 5))
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
      expect(record(fixture, 'old')).toMatchObject([
        {
          description: 'Original label',
          membership: 'settled',
          outcome: 'succeeded',
          totalTokens: 12
        }
      ])
      expect(record(fixture, 'sibling')).toMatchObject([{ outcome: 'succeeded' }])
      const reply = (await fixture.rig.rows()).find((row) => row.agentId === 'old')
      expect(reply?.turnScope).toEqual(spawnScope)
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
      laterGroups(fixture, false)
      openTurn(fixture, 'current', 300)
      toolResult(fixture, kind, 301)
      expect(record(fixture, 'old')).toMatchObject([
        { membership: 'settled', outcome: kind === 'output' ? 'succeeded' : 'cancelled' }
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

  it('keeps a stopped child stopped through late progress, a repeated spawn and a finish', async () => {
    const fixture = await openAcpFixtureRig()
    openTurn(fixture, 'original', 1)
    spawn(fixture, 'old', 'original', 2)
    toolResult(fixture, 'kill', 3)
    fixture.apply(fixture.lane().promptResult('original', { stopReason: 'end_turn' }, 4))
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
    expect(record(fixture, 'old')).toMatchObject([{ membership: 'settled', outcome: 'cancelled' }])
    expect((await fixture.rig.rows()).filter((row) => row.agentId === 'old')).toEqual([])
  })

  it('lane disposal ends observation: the host hears the session end, and nothing after it', async () => {
    const fixture = await openAcpFixtureRig()
    const evidence: AgentChildWorkEvidence[] = []
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
      },
      onChildWorkEvidence: (batch) => evidence.push(...batch)
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
    await fixture.rig.rows()
    // Repeated session-end evidence must not revive the child.
    expect(evidence.map((edge) => edge.type).slice(0, 2)).toEqual(['live', 'session-ended'])
    expect(evidence.filter((edge) => edge.type === 'live')).toHaveLength(1)
  })
})
