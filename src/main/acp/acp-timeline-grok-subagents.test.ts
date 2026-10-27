import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { isBackgroundTaskBlock } from '../../shared/native-chat-types'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { openAcpFixtureRig, readAcpFixture } from './acp-timeline-fixture.test-support'

afterEach(closeProviderTimelineRigs)

type Fixture = Awaited<ReturnType<typeof openAcpFixtureRig>>

function subagents(fixture: Fixture) {
  return fixture.subagents().map((view) => ({
    id: view.providerId,
    label: view.description,
    membership: view.membership,
    outcome: view.outcome,
    tokens: view.totalTokens
  }))
}

function replies(rows: AgentJournalRenderItem[]) {
  return rows.flatMap((row) =>
    row.agentId !== undefined && row.body.kind === 'message'
      ? [{ agentId: row.agentId, role: row.body.role, blocks: row.body.blocks }]
      : []
  )
}

function backgroundTasks(rows: AgentJournalRenderItem[]) {
  return rows.flatMap((row) =>
    row.body.kind === 'message' ? row.body.blocks.filter(isBackgroundTaskBlock) : []
  )
}

function notification(update: Record<string, unknown>) {
  return { sessionId: 'session-1', update }
}

async function untilSpawned() {
  const frames = await readAcpFixture('s7-subagent-background')
  const spawned = frames.findIndex((frame) =>
    JSON.stringify(frame.message.params ?? null).includes('"subagent_spawned"')
  )
  return frames.slice(0, spawned + 1)
}

describe('Grok subagents through the shared timeline', () => {
  it('a foreground subagent is one record that completes, with its reply filed under it', async () => {
    const fixture = await openAcpFixtureRig()
    const rows = await fixture.feed(await readAcpFixture('s7-subagent-foreground'))
    expect(subagents(fixture)).toEqual([
      {
        id: 'subagent-1',
        label: 'Count note lines',
        membership: 'settled',
        outcome: 'succeeded',
        tokens: 13778
      }
    ])
    expect(replies(rows)).toEqual([
      { agentId: 'subagent-1', role: 'assistant', blocks: [{ type: 'text', text: '4' }] }
    ])
    // Child traffic must not become parent-conversation messages.
    expect(
      rows.flatMap((row) =>
        row.body.kind === 'tool-call' ? [[row.body.name, row.body.state]] : []
      )
    ).toEqual([['spawn_subagent', 'completed']])
    expect(backgroundTasks(rows)).toEqual([])
    expect((await fixture.rig.turns()).map((turn) => turn.outcome)).toEqual(['success'])
  })

  it('a background subagent completes from Grok, and reading its output adds no background task', async () => {
    const fixture = await openAcpFixtureRig()
    const rows = await fixture.feed(await readAcpFixture('s7-subagent-background'))
    expect(subagents(fixture)).toMatchObject([
      { id: 'subagent-1', label: 'List folder files', outcome: 'succeeded', tokens: 13829 }
    ])
    expect(replies(rows)).toEqual([
      {
        agentId: 'subagent-1',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'notes.txt, README.md' }]
      }
    ])
    expect(backgroundTasks(rows)).toEqual([])
  })

  it('Stop ends a foreground and a background subagent as stopped, and a later read keeps them so', async () => {
    const fixture = await openAcpFixtureRig()
    const rows = await fixture.feed(await readAcpFixture('s7-subagent-stop'))
    expect(subagents(fixture)).toMatchObject([
      { id: 'subagent-1', label: 'Slow sleeper', outcome: 'cancelled', tokens: 4094 },
      { id: 'subagent-2', label: 'Background sleeper', outcome: 'cancelled', tokens: 4094 }
    ])
    expect(replies(rows)).toEqual([])
    expect(backgroundTasks(rows)).toEqual([])
    expect((await fixture.rig.turns()).map((turn) => [turn.state, turn.outcome])).toEqual([
      ['interrupted', 'cancellation'],
      ['interrupted', 'cancellation'],
      ['completed', 'success']
    ])
  })

  it('a kill stops a running subagent without a background-task row, and nothing relights it', async () => {
    const fixture = await openAcpFixtureRig()
    await fixture.feed(await untilSpawned())
    expect(subagents(fixture).map((entry) => entry.membership)).toEqual(['live'])
    const lane = fixture.lane()
    fixture.apply(
      lane.notification(
        'session/update',
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'kill-1',
            title: 'kill_command_or_subagent',
            status: 'completed',
            rawInput: { task_ids: ['subagent-1'] },
            _meta: { 'x.ai/tool': { name: 'kill_command_or_subagent' } }
          }
        },
        2000
      )
    )
    fixture.apply(
      lane.notification(
        '_x.ai/session_notification',
        notification({ sessionUpdate: 'subagent_spawned', subagent_id: 'subagent-1' }),
        2001
      )
    )
    fixture.apply(
      lane.notification(
        '_x.ai/session_notification',
        notification({
          sessionUpdate: 'subagent_progress',
          subagent_id: 'subagent-1',
          tokens_used: 7
        }),
        2002
      )
    )
    expect(subagents(fixture)).toMatchObject([
      { id: 'subagent-1', membership: 'settled', outcome: 'cancelled' }
    ])
    expect(backgroundTasks(await fixture.rig.rows())).toEqual([])
  })

  it('an output read naming a subagent this run never saw adds no entry', async () => {
    const fixture = await openAcpFixtureRig()
    await fixture.feed(await readAcpFixture('s7-subagent-foreground'))
    fixture.apply(
      fixture.lane().notification(
        'session/update',
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'read-1',
            status: 'completed',
            rawOutput: {
              type: 'TaskOutput',
              Result: {
                task_id: 'elsewhere',
                command: '[subagent:explore] Old',
                status: 'completed'
              }
            },
            _meta: { 'x.ai/tool': { name: 'get_command_or_subagent_output' } }
          }
        },
        2000
      )
    )
    expect(subagents(fixture).map((entry) => entry.id)).toEqual(['subagent-1'])
  })

  it('a subagent still running when the session ends reads unverifiable', async () => {
    const fixture = await openAcpFixtureRig()
    await fixture.feed(await untilSpawned())
    expect(subagents(fixture).map((entry) => entry.membership)).toEqual(['live'])
    fixture.apply([{ type: 'session.ended', verdict: { state: 'unverifiable' } }])
    expect(subagents(fixture).map((entry) => entry.outcome)).toEqual(['unknown'])
  })
})
