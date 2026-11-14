import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  openAcpAdapterRig,
  replyChunk,
  sendHello,
  waitFor,
  type AcpAdapterRig
} from './testing/acp-structured-adapter.test-support'

afterEach(async () => {
  vi.useRealTimers()
  await closeProviderTimelineRigs()
})

async function journalTurns(rig: AcpAdapterRig) {
  return (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
}

describe('ACP connection loss', () => {
  it('settles a send the agent never took as unknown when its stdin breaks, stops the child and tells the host', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'lost')
    await rig.frame('session/prompt')
    await sendHello(rig, 'held')
    rig.child().agent.stdin.destroy()
    await rig.settle()
    await waitFor(() =>
      expect(rig.ended).toMatchObject([
        { type: 'ended', cause: 'unexpected-exit', acquisitionGeneration: 'gen-acp' }
      ])
    )
    expect(rig.settled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clientMessageId: 'lost', state: 'unknown' }),
        expect.objectContaining({ clientMessageId: 'held', state: 'rejected' })
      ])
    )
    expect(rig.child().closes).toBe(1)
    // An unacknowledged prompt never opened a turn to mark complete.
    expect(await journalTurns(rig)).toEqual([])
    await expect(sendHello(rig, 'after')).rejects.toThrow(/no live grok child/)
  })

  it('leaves a running turn unverifiable, never completed, when its stdin breaks mid-turn', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'lost')
    await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:lost', 'partial'))
    await rig.settle()
    rig.child().agent.stdin.destroy()
    await waitFor(async () =>
      expect((await journalTurns(rig)).at(-1)).toMatchObject({ state: 'unverifiable' })
    )
    expect(rig.child().closes).toBe(1)
  })

  it('ends the turn as failed on an answer Orca cannot read, and sends the next message', async () => {
    const rig = await openAcpAdapterRig()
    await rig.acquire()
    await sendHello(rig, 'garbled')
    const prompt = await rig.frame('session/prompt')
    rig.child().agent.notify('session/update', replyChunk('prompt:garbled', 'partial'))
    rig.child().agent.reply(prompt, {
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 2 }
    })
    await rig.settle()
    expect((await journalTurns(rig)).at(-1)).toMatchObject({
      state: 'completed',
      outcome: 'failure'
    })
    await sendHello(rig, 'next')
    const next = await rig.frame('session/prompt', 1)
    expect(rig.sent('session/cancel')).toEqual([])
    rig.child().agent.notify('session/update', replyChunk('prompt:next', 'ok'))
    rig.child().agent.reply(next, { stopReason: 'end_turn' })
    await rig.settle()
    expect(rig.settled.map((settled) => settled.clientMessageId)).toEqual(['garbled', 'next'])
    expect(rig.child().closes).toBe(0)
    expect(rig.ended).toEqual([])
  })
})
