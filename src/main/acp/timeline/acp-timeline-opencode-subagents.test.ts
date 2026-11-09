import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'
import {
  openAcpFixtureRig,
  readAcpFixture,
  type AcpFixtureFrame
} from './testing/acp-timeline-fixture.test-support'

afterEach(closeProviderTimelineRigs)

type Fixture = Awaited<ReturnType<typeof openAcpFixtureRig>>

function subagents(fixture: Fixture) {
  return fixture.subagents().map((view) => ({
    id: view.providerId,
    label: view.description,
    membership: view.membership,
    outcome: view.outcome
  }))
}

function tools(rows: AgentJournalRenderItem[]) {
  return rows.flatMap((row) =>
    row.body.kind === 'tool-call'
      ? [{ agentId: row.agentId, name: row.body.name, state: row.body.state }]
      : []
  )
}

function commands(rows: AgentJournalRenderItem[], agentId: string) {
  return rows.flatMap((row) =>
    row.agentId === agentId && row.body.kind === 'tool-call'
      ? [
          typeof row.body.input === 'object' &&
          row.body.input !== null &&
          'command' in row.body.input
            ? row.body.input.command
            : undefined
        ]
      : []
  )
}

function texts(rows: AgentJournalRenderItem[], agentId: string) {
  return rows.flatMap((row) =>
    row.agentId === agentId && row.body.kind === 'message'
      ? row.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      : []
  )
}

/** Frames through the `index`-th one that matches. */
function through(frames: AcpFixtureFrame[], matches: (text: string) => boolean, index = 0) {
  const ends = frames.flatMap((frame, at) => (matches(JSON.stringify(frame)) ? [at] : []))
  return frames.slice(0, ends[index] + 1)
}

const opened = () => openAcpFixtureRig(OPENCODE_ACP_DIALECT, { journalOwnership: true })

describe('OpenCode subagents through the shared timeline', () => {
  it('a subagent is one record that completes, and its own work is filed under it', async () => {
    const fixture = await opened()
    const rows = await fixture.feed(await readAcpFixture('opencode-v2-subagent-foreground'))
    expect(subagents(fixture)).toEqual([
      { id: 'session-2', label: 'Run sleep command', membership: 'settled', outcome: 'succeeded' }
    ])
    expect(tools(rows)).toEqual([
      { agentId: undefined, name: 'subagent', state: 'completed' },
      { agentId: 'session-2', name: 'shell', state: 'completed' }
    ])
    expect(texts(rows, 'session-2')).toEqual(['DONE'])
  })

  it('a background subagent stays open after the turn ends and its later work still lands', async () => {
    const fixture = await opened()
    const frames = await readAcpFixture('opencode-v2-subagent-background')
    const turn = through(frames, (text) => text.includes('"stopReason"'))
    await fixture.feed(turn)
    expect(subagents(fixture)).toMatchObject([{ id: 'session-2', membership: 'live' }])
    // Commit each frame before the next, so later tool updates read their placement back.
    for (const frame of frames.slice(turn.length)) {
      await fixture.feed([frame])
    }
    const rows = await fixture.rig.rows()
    expect(subagents(fixture)).toMatchObject([
      { id: 'session-2', membership: 'settled', outcome: 'succeeded' }
    ])
    expect(tools(rows).filter((tool) => tool.agentId === 'session-2')).toEqual([
      { agentId: 'session-2', name: 'shell', state: 'completed' }
    ])
    expect(commands(rows, 'session-2')).toEqual(['sleep 20'])
    expect(texts(rows, 'session-2')).toEqual(['DONE'])
  })

  it('a subagent command that spans the end of the turn keeps running and then completes', async () => {
    const fixture = await opened()
    const frames = await readAcpFixture('opencode-v2-subagent-background')
    const ending = frames.findIndex((frame) => JSON.stringify(frame).includes('"stopReason"'))
    const childStart = frames.findIndex((frame) =>
      JSON.stringify(frame).includes('"sessionUpdate":"tool_call_update","toolCallId":"session-2:')
    )
    // The turn ends while the subagent's command runs.
    const spanning = [
      ...frames.slice(0, ending),
      ...frames.slice(ending + 1, childStart + 1),
      frames[ending],
      ...frames.slice(childStart + 1)
    ]
    const rows = await fixture.feed(spanning)
    expect(tools(rows).filter((tool) => tool.agentId === 'session-2')).toEqual([
      { agentId: 'session-2', name: 'shell', state: 'completed' }
    ])
  })

  it('Stop interrupts the subagent and settles its running command', async () => {
    const fixture = await opened()
    const rows = await fixture.feed(await readAcpFixture('opencode-v2-subagent-stop'))
    expect(subagents(fixture)).toMatchObject([
      { id: 'session-2', membership: 'settled', outcome: 'cancelled' }
    ])
    expect(
      tools(rows).filter((tool) => tool.agentId === 'session-2' && tool.state === 'running')
    ).toEqual([])
  })

  it('closing a background subagent after the turn ends interrupts it and leaves nothing running', async () => {
    const fixture = await opened()
    const frames = await readAcpFixture('opencode-v2-subagent-close')
    const closing = frames.findIndex((frame) => frame.message.method === 'session/close')
    await fixture.feed(frames.slice(0, closing))
    expect(fixture.lane().children.live()).toEqual(['session-2'])
    const rows = await fixture.feed(frames.slice(closing))
    expect(subagents(fixture)).toMatchObject([
      { id: 'session-2', membership: 'settled', outcome: 'cancelled' }
    ])
    expect(fixture.lane().children.live()).toEqual([])
    expect(
      tools(rows).filter((tool) => tool.agentId === 'session-2' && tool.state === 'running')
    ).toEqual([])
  })

  it('a follow-up to a finished subagent reopens it until its second run ends', async () => {
    const fixture = await opened()
    const frames = await readAcpFixture('opencode-v2-subagent-rerun')
    const running = (text: string) => text.includes('"status":"running"')
    const firstRun = through(frames, running, 1)
    await fixture.feed(firstRun)
    expect(subagents(fixture)).toMatchObject([{ id: 'session-2', membership: 'live' }])
    const rows = await fixture.feed(frames.slice(firstRun.length))
    expect(subagents(fixture)).toMatchObject([
      { id: 'session-2', membership: 'settled', outcome: 'succeeded' }
    ])
    expect(texts(rows, 'session-2')).toEqual(['FIRST', 'SECOND'])
  })

  it('a long-running subagent keeps one message open per channel, however many steps it takes', () => {
    // OpenCode starts new message ids each step and never appends to an earlier step's.
    const mostOpen = (steps: number) => {
      const lane = new AcpTimelineTranslator({
        sessionId: 'session-1',
        dialect: OPENCODE_ACP_DIALECT
      })
      const open = new Set<string>()
      let most = 0
      const report = (body: Record<string, unknown>) => {
        for (const event of lane.notification(
          'opencode/session/child_update',
          { ...CHILD, ...body },
          1000
        )) {
          const key = 'item' in event ? JSON.stringify(event.item) : ''
          if (event.type === 'text.delta') {
            open.add(key)
          } else if (event.type === 'text.close') {
            open.delete(key)
          }
          most = Math.max(most, open.size)
        }
      }
      report({ type: 'status', status: 'running' })
      for (let step = 0; step < steps; step++) {
        report(chunk('agent_thought_chunk', `msg-${step}:reasoning:0`, 'thinking'))
        report(chunk('agent_message_chunk', `msg-${step}`, `step ${step}`))
      }
      report({ type: 'status', status: 'completed' })
      return { most, left: open.size }
    }
    expect(mostOpen(10)).toEqual({ most: 2, left: 0 })
    expect(mostOpen(100)).toEqual({ most: 2, left: 0 })
  })

  it('a reply that resumes after the subagent thinks or runs a tool keeps all of its text', async () => {
    const fixture = await opened()
    const lane = fixture.lane()
    const report = (body: Record<string, unknown>) =>
      fixture.apply(lane.notification('opencode/session/child_update', { ...CHILD, ...body }, 1000))
    report({ type: 'status', status: 'created', title: 'Helper' })
    report(chunk('agent_message_chunk', 'msg-1', 'A'))
    report(chunk('agent_thought_chunk', 'msg-1:reasoning:0', 'R'))
    report({
      type: 'update',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'session-2:t1',
        title: 'shell',
        status: 'pending'
      }
    })
    report(chunk('agent_message_chunk', 'msg-1', 'B'))
    report({ type: 'status', status: 'completed' })
    expect(texts(await fixture.rig.rows(), 'session-2')).toEqual(['AB', 'R'])
  })
})

const CHILD = {
  rootSessionId: 'session-1',
  childSessionId: 'session-2',
  parentSessionId: 'session-1'
}

function chunk(sessionUpdate: string, messageId: string, text: string) {
  return {
    type: 'update',
    update: { sessionUpdate, messageId, content: { type: 'text', text } }
  }
}
