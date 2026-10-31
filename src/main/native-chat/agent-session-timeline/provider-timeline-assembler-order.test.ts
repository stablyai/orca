import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_PROVIDER_TIMELINE_OPEN_ENTRIES } from './provider-timeline-budget'
import {
  assistantText,
  backgroundTask,
  backgroundTaskState,
  closeProviderTimelineRigs,
  messageText,
  openProviderTimelineRig,
  providerItemId,
  providerTurnItemId,
  runningTool,
  pendingApproval
} from './provider-timeline-assembler-test-support'

afterEach(async () => {
  vi.useRealTimers()
  await closeProviderTimelineRigs()
})

async function heldWindowRig() {
  const runs: (() => void)[] = []
  const rig = await openProviderTimelineRig({
    schedule: (run) => {
      runs.push(run)
      return () => {}
    }
  })
  return { rig, fire: () => runs.splice(0).forEach((run) => run()) }
}

describe('one canonical row per provider item', () => {
  it('writes each named message to its own row, even on one provider stream', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'message-1' },
      channel: 'assistant',
      text: 'First'
    })
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'message-2' },
      channel: 'assistant',
      text: 'Second'
    })
    rig.assembler.flush()
    expect(messageText((await rig.row(providerItemId('item', 'message-1')))?.body)).toBe('First')
    expect(messageText((await rig.row(providerItemId('item', 'message-2')))?.body)).toBe('Second')
  })

  it('refuses a named message whose channel changes mid-stream instead of mixing them', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'm1' },
      channel: 'assistant',
      text: 'Reply'
    })
    expect(
      rig.assembler.apply({
        type: 'text.delta',
        item: { id: 'm1' },
        channel: 'reasoning',
        text: 'x'
      }).dropped
    ).toBe('stream-mismatch')
    rig.assembler.flush()
    expect(messageText((await rig.row(providerItemId('item', 'm1')))?.body)).toBe('Reply')
  })

  it('starts the next anonymous message when its producer changes', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { stream: 'out' },
      channel: 'assistant',
      text: 'Root'
    })
    rig.assembler.apply({
      type: 'text.delta',
      item: { stream: 'out' },
      channel: 'assistant',
      text: 'Helper',
      producer: { agentId: 'helper-1' }
    })
    rig.assembler.flush()
    const messages = (await rig.rows()).filter((row) => row.body.kind === 'message')
    expect(messages.map((row) => [messageText(row.body), row.agentId])).toEqual([
      ['Root', undefined],
      ['Helper', 'helper-1']
    ])
  })

  it('settles a streamed message through its full snapshot as the same row', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'item.open', item: 'm1', body: assistantText('') })
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'm1' },
      channel: 'assistant',
      text: 'Hel'
    })
    rig.assembler.apply({ type: 'item.close', item: 'm1', body: assistantText('Hello, final') })
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed' })
    const messages = (await rig.rows()).filter((row) => row.body.kind === 'message')
    expect(messages.map((row) => [row.itemId, messageText(row.body)])).toEqual([
      [providerItemId('item', 'm1'), 'Hello, final']
    ])
  })

  it('keeps every open stream’s whole text while the budget holds them, and refuses the next', async () => {
    const rig = await openProviderTimelineRig({ schedule: () => () => {} })
    for (let index = 0; index < MAX_PROVIDER_TIMELINE_OPEN_ENTRIES; index += 1) {
      rig.assembler.apply({
        type: 'text.delta',
        item: { id: `m${index}` },
        channel: 'assistant',
        text: 'A'
      })
    }
    expect(
      rig.assembler.apply({
        type: 'text.delta',
        item: { id: 'one-more' },
        channel: 'assistant',
        text: 'A'
      }).admission
    ).toEqual({ accepted: false, reason: 'failed' })
    rig.assembler.apply({ type: 'text.delta', item: { id: 'm0' }, channel: 'assistant', text: 'B' })
    rig.assembler.flush()
    expect(messageText((await rig.row(providerItemId('item', 'm0')))?.body)).toBe('AB')
  })
})

describe('structural events preserve text ordering', () => {
  it('writes text that arrived before a tool ahead of the tool, named stream or not', async () => {
    const { rig, fire } = await heldWindowRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'm1' },
      channel: 'assistant',
      text: 'First'
    })
    rig.assembler.apply({ type: 'item.open', item: 'tool', body: runningTool('read') })
    fire()
    rig.assembler.flush()
    const items = (await rig.rows()).filter((row) => row.body.kind !== 'turn')
    expect(items.map((row) => row.itemId)).toEqual([
      providerItemId('item', 'm1'),
      providerItemId('item', 'tool')
    ])
  })

  it('starts a new anonymous message after a context report, as after any row', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { stream: 's1' },
      channel: 'assistant',
      text: 'First'
    })
    rig.assembler.apply({
      type: 'context.usage',
      usage: { window: { tokens: 1_000, capturedAt: 1_100 } }
    })
    rig.assembler.apply({
      type: 'text.delta',
      item: { stream: 's1' },
      channel: 'assistant',
      text: 'Second'
    })
    rig.assembler.flush()
    const messages = (await rig.rows()).filter((row) => row.body.kind === 'message')
    expect(messages.map((row) => messageText(row.body))).toEqual(['First', 'Second'])
  })

  it('does not split a message on an event it dropped or on the activity line', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { stream: 's1' },
      channel: 'assistant',
      text: 'One '
    })
    expect(rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 }).dropped).toBe(
      'turn-duplicate'
    )
    rig.assembler.apply({ type: 'activity', text: 'Thinking' })
    rig.assembler.apply({
      type: 'text.delta',
      item: { stream: 's1' },
      channel: 'assistant',
      text: 'message'
    })
    rig.assembler.flush()
    const messages = (await rig.rows()).filter((row) => row.body.kind === 'message')
    expect(messages.map((row) => messageText(row.body))).toEqual(['One message'])
  })
})

describe('explicit provider attribution', () => {
  it('scopes a late item to the earlier turn the provider names', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed' })
    rig.assembler.apply({ type: 'turn.open', turn: 't2', at: 3_000 })
    rig.assembler.apply({
      type: 'item.close',
      item: 'late-t1-message',
      body: assistantText('Late output from t1'),
      join: { turn: 't1' }
    })
    expect((await rig.row(providerItemId('item', 'late-t1-message')))?.turnScope).toEqual({
      kind: 'turn',
      turnItemId: providerTurnItemId('t1')
    })
  })

  it('keeps a background task in the turn it opened in when it settles after the next turn opened', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'item.open', item: 'bg', body: backgroundTask('bg', 'working') })
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed' })
    rig.assembler.apply({ type: 'turn.open', turn: 't2', at: 3_000 })
    rig.assembler.apply({ type: 'item.close', item: 'bg', body: backgroundTask('bg', 'done') })
    const row = await rig.row(providerItemId('item', 'bg'))
    expect(row?.turnScope).toEqual({ kind: 'turn', turnItemId: providerTurnItemId('t1') })
    expect(await backgroundTaskState(rig, 'bg')).toBe('done')
  })

  it('writes context facts onto the turn the provider names, not the open one', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed' })
    rig.assembler.apply({ type: 'turn.open', turn: 't2', at: 3_000 })
    rig.assembler.apply({
      type: 'context.usage',
      usage: { window: { tokens: 5_000, capturedAt: 3_100 } },
      join: { turn: 't1' }
    })
    expect(await rig.turn('t1')).toMatchObject({ contextUsage: { window: { tokens: 5_000 } } })
    expect(await rig.turn('t2')).not.toHaveProperty('contextUsage')
  })
})

it.each(['assistant', 'reasoning'] as const)(
  'separates %s metadata from actual placement, replacement and final barriers',
  async (channel) => {
    const rig = await openProviderTimelineRig({ schedule: () => () => {} })
    const a = rig.assembler
    const delta = (id: string, text: string) =>
      a.apply({ type: 'text.delta', item: { id }, channel, text })
    const usage = (turn?: string) =>
      a.apply({
        type: 'context.usage',
        usage: { window: { tokens: 1000, capturedAt: 2 } },
        ...(turn ? { join: { turn } } : {})
      })
    const messages = () =>
      rig.journal.snapshot().items.filter((item) => item.body.kind === 'message')
    usage()
    expect(rig.journal.snapshot().items).toEqual([])
    a.apply({ type: 'turn.open', turn: 'old', at: 1 })
    a.apply({ type: 'turn.end', state: 'completed', at: 2 })
    a.apply({ type: 'turn.open', turn: 'current', at: 3 })
    delta('blank', '')
    delta('white', ' \n ')
    delta('named', 'First')
    for (const turn of [undefined, 'old', 'current', 'missing']) {
      usage(turn)
    }
    await rig.eventSink.written?.()
    expect(messages()).toEqual([])
    // Suppression is the classifier's actual null output, not an arbitrary empty decision.
    a.apply({
      type: 'provider.frame',
      frameKind: 'request:extension/delta',
      payload: { sessionId: 'session' }
    })
    await rig.eventSink.written?.()
    expect(messages()).toEqual([])
    a.apply({ type: 'text.delta', item: { stream: 'anonymous' }, channel, text: 'Second' })
    usage('missing')
    await rig.eventSink.written?.()
    expect(messages().map((item) => messageText(item.body))).toEqual(['First', 'Second'])
    const first = structuredClone(messages())
    a.apply({ type: 'text.delta', item: { stream: 'anonymous' }, channel, text: 'Third' })
    a.apply({ type: 'text.close', item: { stream: 'anonymous' } })
    delta('named', ' tail')
    // A positioned unrelated tail is not a predecessor of a newly released anonymous row.
    a.apply({ type: 'text.delta', item: { stream: 'other' }, channel, text: 'Fourth' })
    usage()
    await rig.eventSink.written?.()
    expect(messages().map((item) => messageText(item.body))).toEqual([
      'First',
      'Second',
      'Third',
      'Fourth'
    ])
    a.apply({
      type: 'text.delta',
      item: { stream: 'child' },
      channel,
      text: 'Child',
      producer: { agentId: 'child' }
    })
    usage()
    await rig.eventSink.written?.()
    expect(messages()).toHaveLength(4)
    // Visible fallback, request and tool really order preceding text.
    a.apply({ type: 'provider.frame', frameKind: 'unmodeled-result', payload: { answer: 1 } })
    a.apply({ type: 'request.open', request: 'approval', body: pendingApproval })
    a.apply({ type: 'item.open', item: 'tool', body: runningTool('read') })
    await rig.eventSink.written?.()
    expect(messages()[0]).toMatchObject({
      ...first[0],
      revision: first[0].revision + 1,
      body: { role: channel, blocks: [{ type: 'text', text: 'First tail' }] }
    })
    expect(messages().map((item) => messageText(item.body))).toContain('Child')
    for (const final of [undefined, '', 'Final']) {
      const id = `final-${String(final)}`
      delta(id, 'start')
      a.flush()
      await rig.eventSink.written?.()
      delta(id, 'stale')
      a.apply({ type: 'text.close', item: { id }, ...(final === undefined ? {} : { text: final }) })
      delta(id, 'resurrection')
      await rig.eventSink.written?.()
      expect(messageText(rig.journal.item(providerItemId('item', id))?.body)).toBe(
        final ?? 'startstale'
      )
    }
    a.apply({
      type: 'item.close',
      item: 'named',
      body: { kind: 'message', role: channel, blocks: [{ type: 'text', text: 'Replacement' }] }
    })
    a.apply({ type: 'turn.end', state: 'completed', at: 9 })
    const original = structuredClone(await rig.rows())
    const reopened = await rig.reopenJournal()
    expect(reopened.snapshot().items).toEqual(original)
    expect(reopened.publicRead().snapshot.items).toEqual(original)
  }
)

it('preserves first meaningful append order after an empty named start at real placement barriers', async () => {
  for (const metadata of [false, true]) {
    const r = await openProviderTimelineRig({ schedule: () => () => {} })
    const delta = (item: { id: string } | { stream: string }, text: string) =>
      r.assembler.apply({ type: 'text.delta', item, text, channel: 'assistant' })
    delta({ id: 'empty-start' }, '')
    delta({ id: 'earlier-text' }, 'First')
    delta({ id: 'empty-start' }, 'Second')
    if (metadata) {
      delta({ stream: 'anonymous' }, 'Third')
      r.assembler.apply({
        type: 'context.usage',
        usage: { used: { kind: 'unknown', capturedAt: 10 } }
      })
    } else {
      r.assembler.apply({ type: 'item.close', item: 'tool', body: runningTool('real boundary') })
    }
    await r.eventSink.written?.()
    expect(
      r.journal
        .snapshot()
        .items.filter((row) => row.body.kind === 'message')
        .map((row) => messageText(row.body))
    ).toEqual(metadata ? ['First', 'Second', 'Third'] : ['First', 'Second'])
  }
})
