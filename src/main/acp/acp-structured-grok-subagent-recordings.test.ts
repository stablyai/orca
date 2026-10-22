// The adapter against Grok's recorded subagents (Grok 1.0.46): each recording plays back as the
// agent, and the assertions read what it reports to the host about each subagent and the reply
// rows a client would see.

import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { isBackgroundTaskBlock } from '../../shared/native-chat-types'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  openAcpAdapterRig,
  waitFor,
  type AcpAdapterRig
} from './acp-structured-adapter.test-support'
import { GrokFixtureReplay } from './acp-structured-fixture-replay.test-support'
import { readAcpFixture } from './acp-timeline-fixture.test-support'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const ask: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Fixture prompt' }]
}

async function replaying(name: string) {
  const replay = new GrokFixtureReplay(await readAcpFixture(name))
  const evidence: AgentChildWorkEvidence[] = []
  const rig = await openAcpAdapterRig({
    script: (agent) => replay.attach(agent),
    deps: { onChildWorkEvidence: (_sessionId, batch) => evidence.push(...batch) }
  })
  await rig.acquire()
  return { rig, replay, evidence }
}

function send(rig: AcpAdapterRig, clientMessageId: string) {
  return rig.adapter.dispatch({ sessionId: SESSION, clientMessageId, body: ask, fence: 1 })
}

type Reported = { id: string; label?: string; outcome?: string; tokens?: number }

/** Each subagent as the adapter last reported it to the host. */
function subagents(evidence: readonly AgentChildWorkEvidence[]): Reported[] {
  const reported = new Map<string, Reported>()
  for (const edge of evidence) {
    const handle =
      edge.type === 'live' ? edge.child.handle : edge.type === 'ended' ? edge.handle : null
    if (!handle) {
      continue
    }
    const prior = reported.get(handle.id) ?? { id: handle.id }
    const tokens =
      edge.type === 'live'
        ? edge.child.totalTokens
        : edge.type === 'ended'
          ? edge.totalTokens
          : undefined
    reported.set(handle.id, {
      ...prior,
      ...(edge.type === 'live' && edge.child.description ? { label: edge.child.description } : {}),
      ...(edge.type === 'ended' ? { outcome: edge.outcome } : {}),
      ...(tokens !== undefined ? { tokens } : {})
    })
  }
  return [...reported.values()]
}

async function replies(rig: AcpAdapterRig) {
  return (await rig.rig.rows()).flatMap((row) =>
    row.agentId !== undefined && row.body.kind === 'message'
      ? [{ agentId: row.agentId, blocks: row.body.blocks }]
      : []
  )
}

async function backgroundTasks(rig: AcpAdapterRig) {
  return (await rig.rig.rows()).flatMap((row) =>
    row.body.kind === 'message' ? row.body.blocks.filter(isBackgroundTaskBlock) : []
  )
}

async function turns(rig: AcpAdapterRig) {
  return (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
}

async function stop(rig: AcpAdapterRig, replay: GrokFixtureReplay) {
  await waitFor(() => expect(replay.awaiting).toBe('session/cancel'))
  await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
    cancelled: true
  })
}

describe('Grok subagent recordings through the adapter', () => {
  it('a foreground subagent completes and its reply opens under it', async () => {
    const { rig, replay, evidence } = await replaying('s7-subagent-foreground')
    await send(rig, 'send-1')
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'completed', outcome: 'success' }])
    )
    expect(subagents(evidence)).toMatchObject([
      { id: 'subagent-1', label: 'Count note lines', outcome: 'succeeded', tokens: 13778 }
    ])
    expect(await replies(rig)).toEqual([
      { agentId: 'subagent-1', blocks: [{ type: 'text', text: '4' }] }
    ])
    expect(evidence).toContainEqual(
      expect.objectContaining({
        type: 'live',
        child: expect.objectContaining({ kind: 'agent', description: 'Count note lines' })
      })
    )
    expect(evidence).toContainEqual(
      expect.objectContaining({ type: 'ended', outcome: 'succeeded' })
    )
  })

  it('a background subagent completes and stays out of the background tasks', async () => {
    const { rig, replay, evidence } = await replaying('s7-subagent-background')
    await send(rig, 'send-1')
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(() =>
      expect(subagents(evidence)).toMatchObject([
        { id: 'subagent-1', label: 'List folder files', outcome: 'succeeded' }
      ])
    )
    expect(await replies(rig)).toEqual([
      { agentId: 'subagent-1', blocks: [{ type: 'text', text: 'notes.txt, README.md' }] }
    ])
    expect(await backgroundTasks(rig)).toEqual([])
    expect(evidence).toContainEqual(
      expect.objectContaining({
        type: 'live',
        child: expect.objectContaining({ kind: 'agent', description: 'List folder files' })
      })
    )
    expect(evidence).toContainEqual(
      expect.objectContaining({ type: 'ended', outcome: 'succeeded' })
    )
  })

  it('Stop while a foreground and then a background subagent runs ends each stopped', async () => {
    const { rig, replay, evidence } = await replaying('s7-subagent-stop')
    await send(rig, 'send-1')
    await stop(rig, replay)
    await waitFor(() => expect(replay.awaiting).toBe('session/prompt'))
    await waitFor(() =>
      expect(subagents(evidence)).toMatchObject([{ label: 'Slow sleeper', outcome: 'cancelled' }])
    )
    await send(rig, 'send-2')
    await stop(rig, replay)
    await waitFor(() => expect(replay.awaiting).toBe('session/prompt'))
    await send(rig, 'send-3')
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect((await turns(rig)).map((turn) => turn.outcome)).toEqual([
        'cancellation',
        'cancellation',
        'success'
      ])
    )
    expect(subagents(evidence)).toMatchObject([
      { id: 'subagent-1', label: 'Slow sleeper', outcome: 'cancelled' },
      { id: 'subagent-2', label: 'Background sleeper', outcome: 'cancelled' }
    ])
    expect(await replies(rig)).toEqual([])
    expect(await backgroundTasks(rig)).toEqual([])
  })
})
