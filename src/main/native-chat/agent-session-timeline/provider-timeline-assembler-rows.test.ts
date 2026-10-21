// Which row an event lands on is spelled from its keys, and an event the sink refused took
// nothing: no key, no row, no room in the budget.

import { afterEach, describe, expect, it } from 'vitest'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  assistantText,
  backgroundTask,
  closeProviderTimelineRigs,
  messageText,
  openProviderTimelineRig,
  pendingApproval,
  providerItemId,
  providerTurnItemId,
  refusingSink
} from './provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

const messages = async (rig: Awaited<ReturnType<typeof openProviderTimelineRig>>) =>
  (await rig.rows()).filter((row) => row.body.kind === 'message')

describe('a refused event takes nothing', () => {
  it('allocates no key and no request row, and its retry lands once', async () => {
    const rig = await openProviderTimelineRig()
    let refusing = false
    const assembler = rig.assemble({ sink: refusingSink(rig.sink, () => refusing) })
    const refused = { accepted: false, reason: 'backpressure' }
    const turnOpen = { type: 'turn.open', at: 1_000 } as const
    const frame = { type: 'provider.frame', frameKind: 'mystery', payload: { a: 1 } } as const
    const request = { type: 'request.open', request: 'p1', body: pendingApproval } as const
    refusing = true
    expect(assembler.apply(turnOpen).admission).toEqual(refused)
    expect(assembler.openTurnId).toBeNull()
    refusing = false
    expect(assembler.apply(turnOpen).admission).toEqual({ accepted: true })
    // The minted turn takes the first serial, as if the refusal never happened.
    expect(assembler.openTurnId).toBe('m:gen-1%3At1')
    refusing = true
    expect(assembler.apply(frame).admission).toEqual(refused)
    expect(assembler.apply(request).admission).toEqual(refused)
    refusing = false
    expect(assembler.apply(frame).admission).toEqual({ accepted: true })
    expect(assembler.apply(request).admission).toEqual({ accepted: true })
    assembler.apply({
      type: 'text.delta',
      item: { stream: 'reply' },
      channel: 'assistant',
      text: 'Hi'
    })
    assembler.flush()

    const rows = (await rig.rows()).filter((row) => row.body.kind !== 'turn')
    expect(rows.map((row) => row.itemId)).toEqual([
      expect.stringContaining('frame%3Am%3Agen-1%253Af2'),
      providerItemId('request', 'p1'),
      expect.stringContaining('item%3Am%3Agen-1%253As3')
    ])
    expect(messageText(rows[2]?.body)).toBe('Hi')
  })
})

describe('a row keeps the turn it opened in', () => {
  it('takes a background task update in the turn it opened in, after that turn ended', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'item.open',
      item: 'background-tool',
      body: backgroundTask('background-tool', 'working')
    })
    rig.assembler.apply({ type: 'turn.end', turn: 't1', at: 2_000, state: 'completed' })
    // No turn is open: the update still joins the row's own turn, not the conversation.
    rig.assembler.apply({
      type: 'item.update',
      item: 'background-tool',
      body: backgroundTask('background-tool', 'done')
    })
    expect(await rig.row(providerItemId('item', 'background-tool'))).toMatchObject({
      turnScope: { kind: 'turn', turnItemId: providerTurnItemId('t1') },
      body: backgroundTask('background-tool', 'done')
    })
  })
})

describe('streamed text has the same lifecycle as the item it streams into', () => {
  it('keeps interleaved same-id streams on separate threads apart', async () => {
    const rig = await openProviderTimelineRig({ ownThread: () => 'root' })
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'm1' },
      channel: 'assistant',
      text: 'Root',
      join: { thread: 'root', turn: 't1' }
    })
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'm1' },
      channel: 'assistant',
      text: 'Child',
      join: { thread: 'child', turn: 'child-turn' }
    })
    rig.assembler.apply({ type: 'turn.end', turn: 't1', at: 2_000, state: 'completed' })

    expect((await messages(rig)).map((row) => [row.itemId, messageText(row.body)])).toEqual([
      [providerItemId('item', 'm1', { thread: 'root' }), 'Root'],
      [providerItemId('item', 'm1', { thread: 'child' }), 'Child']
    ])
  })

  it('settles a message on text.close, so a late delta cannot erase what it said', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'm1' },
      channel: 'assistant',
      text: 'Prefix'
    })
    rig.assembler.apply({ type: 'text.close', item: { id: 'm1' } })
    expect(
      rig.assembler.apply({
        type: 'text.delta',
        item: { id: 'm1' },
        channel: 'assistant',
        text: 'Suffix'
      }).dropped
    ).toBe('item-settled')
    rig.assembler.flush()

    expect(messageText((await rig.row(providerItemId('item', 'm1')))?.body)).toBe('Prefix')
  })
})

describe('the budget counts the work actually open', () => {
  it('frees an answered request incarnation without waiting for its turn to end', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    for (let incarnation = 1; incarnation <= 129; incarnation += 1) {
      expect(
        rig.assembler.apply({ type: 'request.open', request: 'approval', body: pendingApproval })
          .admission
      ).toEqual({ accepted: true })
      await rig.rows()
      const identity = parseAgentJournalItemKey(
        providerItemId('request', 'approval', { incarnation })
      )
      if (!identity) {
        throw new Error('the request has a journal key')
      }
      // A client answers it, through the journal.
      await rig.journal.appendItem(
        identity,
        {
          ...pendingApproval,
          resolution: {
            state: 'resolved',
            selectedOptionId: 'allow',
            resolvedBy: 'phone',
            resolvedAt: 1_100
          }
        },
        { fence: 1, turnScope: { kind: 'turn', turnItemId: providerTurnItemId('t1') } }
      )
    }
  })

  it('keeps a streamed message counted while its stream is open, whatever its snapshots say', async () => {
    const rig = await openProviderTimelineRig({ schedule: () => () => {} })
    for (let index = 0; index < 128; index += 1) {
      rig.assembler.apply({
        type: 'text.delta',
        item: { id: `stream-${index}` },
        channel: 'assistant',
        text: 'x'
      })
      rig.assembler.apply({
        type: 'item.update',
        item: `stream-${index}`,
        body: assistantText('x')
      })
      if (index % 32 === 31) {
        await rig.rows()
      }
    }
    expect(
      rig.assembler.apply({
        type: 'text.delta',
        item: { id: 'overflow' },
        channel: 'assistant',
        text: 'x'
      }).admission
    ).toEqual({ accepted: false, reason: 'failed' })
  })

  it('refuses a provider key larger than the whole budget', () =>
    openProviderTimelineRig({ schedule: () => () => {} }).then((rig) => {
      expect(
        rig.assembler.apply({
          type: 'text.delta',
          item: { id: 'x'.repeat(1024 * 1024 + 1) },
          channel: 'assistant',
          text: 'tiny'
        }).admission
      ).toEqual({ accepted: false, reason: 'failed' })
    }))
})
