import { afterEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalPlainStatusItem
} from '../../../shared/agent-session-journal-types'
import {
  assistantText,
  backgroundTask,
  backgroundTaskState,
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  providerItemId,
  providerTurnItemId,
  runningTool
} from './provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

const plan = (text: string): AgentJournalPlainStatusItem => ({
  kind: 'status',
  text,
  presentation: 'plan-document'
})

function messageText(body: AgentJournalItemBody | undefined): string | undefined {
  return body?.kind === 'message' && body.blocks[0]?.type === 'text'
    ? body.blocks[0].text
    : undefined
}

describe('provider timeline items', () => {
  it('scopes interleaved tool calls and text to the turn they ran in, in arrival order', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { stream: 'reply' },
      channel: 'assistant',
      text: 'Let me '
    })
    rig.assembler.apply({
      type: 'text.delta',
      item: { stream: 'reply' },
      channel: 'assistant',
      text: 'look.'
    })
    rig.assembler.apply({ type: 'item.open', item: 'call-a', body: runningTool('read') })
    rig.assembler.apply({ type: 'item.open', item: 'call-b', body: runningTool('grep') })
    rig.assembler.apply({
      type: 'item.close',
      item: 'call-b',
      body: { ...runningTool('grep'), state: 'completed' }
    })
    rig.assembler.apply({
      type: 'item.close',
      item: 'call-a',
      body: { ...runningTool('read'), state: 'completed' }
    })
    // The tool call ended the anonymous stream, so this text is a new message.
    rig.assembler.apply({
      type: 'text.delta',
      item: { stream: 'reply' },
      channel: 'assistant',
      text: 'Done.'
    })
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed', outcome: 'success' })

    const rows = (await rig.rows()).filter((row) => row.body.kind !== 'turn')
    expect(rows.map((row) => messageText(row.body) ?? row.itemId)).toEqual([
      'Let me look.',
      providerItemId('item', 'call-a'),
      providerItemId('item', 'call-b'),
      'Done.'
    ])
    const turnScope = { kind: 'turn', turnItemId: providerTurnItemId('turn-1') }
    expect(rows.every((row) => JSON.stringify(row.turnScope) === JSON.stringify(turnScope))).toBe(
      true
    )
    expect(rows.filter((row) => row.body.kind === 'tool-call').map((row) => row.body)).toEqual([
      expect.objectContaining({ name: 'read', state: 'completed' }),
      expect.objectContaining({ name: 'grep', state: 'completed' })
    ])
  })

  it('drops a second close of a settled item and keeps the first terminal body', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({
      type: 'item.close',
      item: 'call-a',
      body: { ...runningTool('read'), state: 'completed' }
    })
    const repeat = rig.assembler.apply({
      type: 'item.close',
      item: 'call-a',
      body: { ...runningTool('read'), state: 'failed' }
    })
    expect(repeat.dropped).toBe('item-settled')
    expect((await rig.row(providerItemId('item', 'call-a')))?.body).toMatchObject({
      state: 'completed'
    })
  })

  it('keeps a settled tool terminal body against a later update carrying another', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({ type: 'item.open', item: 'call-a', body: runningTool('read') })
    rig.assembler.apply({
      type: 'item.close',
      item: 'call-a',
      body: { ...runningTool('read'), state: 'failed' }
    })
    const update = rig.assembler.apply({
      type: 'item.update',
      item: 'call-a',
      body: { ...runningTool('read'), state: 'completed' }
    })
    expect(update.dropped).toBe('item-settled')
    expect((await rig.row(providerItemId('item', 'call-a')))?.body).toMatchObject({
      state: 'failed'
    })
  })

  it("keeps the sweep's verdict on a tool against the next child's update", async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({ type: 'item.open', item: 'call-a', body: runningTool('read') })
    const next = await rig.restart()
    expect((await rig.row(providerItemId('item', 'call-a')))?.body).toMatchObject({
      state: 'failed'
    })
    const update = next.apply({
      type: 'item.update',
      item: 'call-a',
      body: { ...runningTool('read'), state: 'completed' },
      join: { turn: 'turn-1' }
    })
    expect(update.dropped).toBe('item-settled')
    expect((await rig.row(providerItemId('item', 'call-a')))?.body).toMatchObject({
      state: 'failed'
    })
  })

  it('reopens a settled item under the same row', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({ type: 'item.close', item: 'agent-1', body: runningTool('task') })
    rig.assembler.apply({ type: 'item.open', item: 'agent-1', body: runningTool('task') })
    rig.assembler.apply({
      type: 'item.close',
      item: 'agent-1',
      body: { ...runningTool('task'), state: 'completed' }
    })
    const rows = (await rig.rows()).filter((row) => row.body.kind === 'tool-call')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.body).toMatchObject({ state: 'completed' })
  })

  it('replaces a plan in place with each whole-list update', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({ type: 'item.update', item: 'plan', body: plan('1. read') })
    rig.assembler.apply({ type: 'item.update', item: 'plan', body: plan('1. read ✓\n2. edit') })
    const rows = (await rig.rows()).filter((row) => row.body.kind === 'status')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.body).toMatchObject({ text: '1. read ✓\n2. edit' })
  })

  it('writes an item that arrives with no turn open as a thread row, opening no turn', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'item.close', item: 'call-a', body: assistantText('stray') })
    expect(rig.assembler.openTurnId).toBeNull()
    const rows = await rig.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.turnScope).toEqual({ kind: 'thread' })
  })

  it('cuts short a tool call its interrupted turn left running, and leaves a background task it started running', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({ type: 'item.open', item: 'call-a', body: runningTool('read') })
    rig.assembler.apply({
      type: 'item.open',
      item: 'bg-1',
      body: backgroundTask('bg-1', 'working')
    })
    rig.assembler.apply({
      type: 'turn.end',
      at: 2_000,
      state: 'interrupted',
      outcome: 'cancellation'
    })
    expect((await rig.row(providerItemId('item', 'call-a')))?.body).toMatchObject({
      state: 'failed',
      endedAs: 'interrupted'
    })
    expect(await backgroundTaskState(rig, 'bg-1')).toBe('working')

    // It settles on its own update later, still in the turn that started it.
    rig.assembler.apply({ type: 'item.close', item: 'bg-1', body: backgroundTask('bg-1', 'done') })
    expect(await backgroundTaskState(rig, 'bg-1')).toBe('done')
    expect((await rig.row(providerItemId('item', 'bg-1')))?.turnScope).toEqual({
      kind: 'turn',
      turnItemId: providerTurnItemId('turn-1')
    })
  })

  it('stamps the producing subagent on its rows', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({
      type: 'item.open',
      item: 'call-a',
      body: runningTool('read'),
      producer: { agentId: 'helper-1' }
    })
    expect((await rig.row(providerItemId('item', 'call-a')))?.agentId).toBe('helper-1')
  })
})

describe('provider timeline text streams', () => {
  it('coalesces a burst of deltas into one snapshot write', async () => {
    const runs: (() => void)[] = []
    const rig = await openProviderTimelineRig({
      schedule: (run) => {
        runs.push(run)
        return () => {}
      }
    })
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    for (const text of ['a', 'b', 'c']) {
      rig.assembler.apply({
        type: 'text.delta',
        item: { stream: 'reply' },
        channel: 'assistant',
        text
      })
    }
    rig.assembler.apply({
      type: 'text.delta',
      item: { stream: 'think' },
      channel: 'reasoning',
      text: 'x'
    })
    expect((await rig.rows()).filter((row) => row.body.kind === 'message')).toHaveLength(0)
    runs.splice(0).forEach((run) => run())
    const [reply, single] = (await rig.rows()).filter((row) => row.body.kind === 'message')
    expect(messageText(reply?.body)).toBe('abc')
    // Three deltas cost the writes one delta does.
    expect(reply?.revision).toBe(single?.revision)
  })

  it('writes every delta of a window once it elapses', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    const delta = { type: 'text.delta', item: { stream: 'reply' }, channel: 'assistant' } as const
    rig.assembler.apply({ ...delta, text: 'Hel' })
    rig.assembler.apply({ ...delta, text: 'lo' })
    const messages = (await rig.rows()).filter((row) => row.body.kind === 'message')
    expect(messages.map((row) => messageText(row.body))).toEqual(['Hello'])
  })

  it('settles with the provider final text, and keys a named message by its id', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'msg-1' },
      channel: 'assistant',
      text: 'Draf'
    })
    rig.assembler.apply({ type: 'text.close', item: { id: 'msg-1' }, text: 'Final answer' })
    expect(messageText((await rig.row(providerItemId('item', 'msg-1')))?.body)).toBe('Final answer')
    expect(rig.assembler.apply({ type: 'text.close', item: { id: 'msg-1' } }).dropped).toBe(
      'stream-unknown'
    )
  })

  it('writes reasoning as a reasoning message, and nothing for a whitespace-only stream', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { stream: 'think' },
      channel: 'reasoning',
      text: 'Hmm'
    })
    rig.assembler.apply({
      type: 'text.delta',
      item: { stream: 'reply' },
      channel: 'assistant',
      text: '  \n'
    })
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed' })
    const messages = (await rig.rows()).filter((row) => row.body.kind === 'message')
    expect(messages.map((row) => row.body)).toEqual([
      { kind: 'message', role: 'reasoning', blocks: [{ type: 'text', text: 'Hmm' }] }
    ])
  })
})
