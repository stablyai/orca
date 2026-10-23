import { afterEach, describe, expect, it } from 'vitest'
import {
  agentJournalToolCallLifecycle,
  interruptedAgentJournalToolCall
} from '../../../shared/agent-journal-tool-call-lifecycle'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session-journal-types'
import { agentJournalTurnBody } from '../../../shared/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  providerItemId,
  providerTurnItemId,
  runningTool,
  type ProviderTimelineRig
} from './provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

async function toolBody(
  rig: ProviderTimelineRig,
  item = 'call-a'
): Promise<AgentJournalToolCallItem> {
  const body = (await rig.row(providerItemId('item', item)))?.body
  if (body?.kind !== 'tool-call') {
    throw new Error(`no tool row for ${item}`)
  }
  return body
}

async function lifecycle(rig: ProviderTimelineRig, item = 'call-a'): Promise<string | undefined> {
  return agentJournalToolCallLifecycle(await toolBody(rig, item))
}

async function openTool(): Promise<ProviderTimelineRig> {
  const rig = await openProviderTimelineRig()
  rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
  rig.assembler.apply({ type: 'item.open', item: 'call-a', body: runningTool('shell') })
  return rig
}

/** As a person's Stop writes it, straight to the journal: the turn interrupted, as their cancellation. */
async function personStops(rig: ProviderTimelineRig): Promise<void> {
  const running = await rig.turn('turn-1')
  const identity = parseAgentJournalItemKey(providerTurnItemId('turn-1'))
  if (!running || !identity) {
    throw new Error('the turn row is written')
  }
  await rig.journal.appendItem(
    identity,
    agentJournalTurnBody({
      ...running,
      state: 'interrupted',
      outcome: 'cancellation',
      completedAt: 2_000
    }),
    { fence: 1, turnScope: { kind: 'thread' } }
  )
}

describe('provider timeline: how a call its turn or session ended reads', () => {
  it('reads interrupted when a stop interrupts its turn, keeping failed for older builds', async () => {
    const rig = await openTool()
    rig.assembler.apply({
      type: 'turn.end',
      at: 2_000,
      state: 'interrupted',
      outcome: 'cancellation'
    })
    expect(await toolBody(rig)).toMatchObject({ state: 'failed', endedAs: 'interrupted' })
    expect(await lifecycle(rig)).toBe('interrupted')
  })

  it('reads interrupted when a newer turn supersedes its turn', async () => {
    const rig = await openTool()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-2', at: 2_000 })
    expect(await lifecycle(rig)).toBe('interrupted')
  })

  it('reads interrupted when the session ends on an observed child exit', async () => {
    const rig = await openTool()
    rig.assembler.apply({
      type: 'session.ended',
      verdict: { state: 'interrupted', completedAt: 3_000 }
    })
    expect(await lifecycle(rig)).toBe('interrupted')
  })

  it.each(['interrupted', 'completed'] as const)(
    "reads interrupted when a person stopped its turn, whatever the provider's later end (%s) says",
    async (providerEnd) => {
      const rig = await openTool()
      await personStops(rig)
      // The Stop leaves the call the provider's to finish.
      rig.assembler.apply({ type: 'activity', text: 'Thinking' })
      expect(await toolBody(rig)).toMatchObject({ state: 'running' })
      rig.assembler.apply({ type: 'turn.end', turn: 'turn-1', at: 2_100, state: providerEnd })
      expect(await toolBody(rig)).toMatchObject({ state: 'failed', endedAs: 'interrupted' })
      expect(await rig.turn('turn-1')).toMatchObject({ state: 'interrupted', completedAt: 2_000 })
    }
  )

  it('keeps a call the provider completed after a person stopped its turn completed', async () => {
    const rig = await openTool()
    rig.assembler.apply({ type: 'item.open', item: 'call-b', body: runningTool('read') })
    await personStops(rig)
    rig.assembler.apply({
      type: 'item.close',
      item: 'call-a',
      body: { ...runningTool('shell'), state: 'completed' },
      join: { turn: 'turn-1' }
    })
    rig.assembler.apply({ type: 'turn.end', turn: 'turn-1', at: 2_100, state: 'interrupted' })
    expect(await lifecycle(rig, 'call-a')).toBe('completed')
    expect(await lifecycle(rig, 'call-b')).toBe('interrupted')
  })

  it('leaves the call unverified when a restarted host settles it with no proof the child died', async () => {
    const rig = await openTool()
    await rig.restart()
    expect(await toolBody(rig)).toMatchObject({ state: 'failed', endedAs: 'unverifiable' })
    expect(await lifecycle(rig)).toBe('failed')
  })

  it.each([
    [
      'the session ends unverified',
      async (rig: ProviderTimelineRig) => {
        rig.assembler.apply({ type: 'session.ended', verdict: { state: 'unverifiable' } })
      }
    ],
    [
      'a restarted host settles it with no proof the child died',
      async (rig: ProviderTimelineRig) => {
        await rig.restart()
      }
    ]
  ])(
    'reads interrupted, as its turn does, when a person stopped its turn and %s',
    async (_, settle) => {
      const rig = await openTool()
      await personStops(rig)
      rig.assembler.apply({ type: 'activity', text: 'Thinking' })
      expect(await toolBody(rig)).toMatchObject({ state: 'running' })
      await settle(rig)
      expect(await toolBody(rig)).toMatchObject({ state: 'failed', endedAs: 'interrupted' })
      expect(await rig.turn('turn-1')).toMatchObject({
        state: 'interrupted',
        outcome: 'cancellation',
        completedAt: 2_000
      })
    }
  )

  it('keeps a call that failed before a person stopped its turn failed across a restart', async () => {
    const rig = await openTool()
    rig.assembler.apply({ type: 'item.open', item: 'call-b', body: runningTool('read') })
    rig.assembler.apply({
      type: 'item.close',
      item: 'call-a',
      body: { ...runningTool('shell'), state: 'failed' },
      join: { turn: 'turn-1' }
    })
    await personStops(rig)
    await rig.restart()
    const failed = await toolBody(rig, 'call-a')
    expect(failed).toMatchObject({ state: 'failed' })
    expect(failed).not.toHaveProperty('endedAs')
    expect(await lifecycle(rig, 'call-b')).toBe('interrupted')
  })

  it('keeps the provider cancelling a call, and a later turn end does not restate it', async () => {
    const rig = await openTool()
    rig.assembler.apply({
      type: 'item.close',
      item: 'call-a',
      body: interruptedAgentJournalToolCall(runningTool('shell'))
    })
    expect(await lifecycle(rig)).toBe('interrupted')
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed' })
    expect(await lifecycle(rig)).toBe('interrupted')
  })

  it('still reads failed when the provider completed the turn around a call it never closed', async () => {
    const rig = await openTool()
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed' })
    const body = await toolBody(rig)
    expect(body).toMatchObject({ state: 'failed' })
    expect(body).not.toHaveProperty('endedAs')
  })

  it('still reads failed when the host lost the child, which proves no interruption', async () => {
    const rig = await openTool()
    rig.assembler.apply({ type: 'session.ended', verdict: { state: 'unverifiable' } })
    expect(await lifecycle(rig)).toBe('failed')
  })

  it('leaves a call that finished before the stop as it finished', async () => {
    const rig = await openTool()
    rig.assembler.apply({
      type: 'item.close',
      item: 'call-a',
      body: { ...runningTool('shell'), state: 'completed' }
    })
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'interrupted' })
    expect(await lifecycle(rig)).toBe('completed')
  })
})
