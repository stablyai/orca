import { afterEach, describe, expect, it } from 'vitest'
import { journalPayload } from '../agent-session-journal/journal-payload-bounds'
import {
  closeProviderTimelineRigs,
  messageText,
  openProviderTimelineRig,
  providerItemId,
  runningTool
} from './provider-timeline-assembler-test-support'
import { ProviderTimelineState, type ProviderTimelineOpenItem } from './provider-timeline-state'

class CountedItems extends Map<string, ProviderTimelineOpenItem> {
  work = 0

  override delete(key: string): boolean {
    this.work += 1
    return super.delete(key)
  }

  override set(key: string, value: ProviderTimelineOpenItem): this {
    this.work += 1
    return super.set(key, value)
  }

  override *[Symbol.iterator](): MapIterator<[string, ProviderTimelineOpenItem]> {
    for (const entry of super[Symbol.iterator]()) {
      this.work += 1
      yield entry
    }
  }
}

afterEach(closeProviderTimelineRigs)

describe('long-turn event scaling', () => {
  it('retires completed keys without traversing unrelated live tools at N and 10N', () => {
    const operations = [200, 2_000].map((count) => {
      const state = new ProviderTimelineState()
      const items = new CountedItems()
      state.items = items
      for (let index = 0; index < count; index += 1) {
        items.set(`tool-${index}`, { kind: 'item', row: null, turnItemId: 'turn' })
      }
      items.work = 0
      for (let index = 0; index < count; index += 1) {
        state.close(`tool-${index}`, 'turn')
      }
      expect(items.work).toBeLessThanOrEqual(count * 2)
      return items.work
    })
    expect(operations[1]).toBeLessThanOrEqual(operations[0]! * 10)
  })

  // The real-scale corpus persists 2,500 rows and their terminal revisions through SQLite.
  it('completes a turn with 2,000 live tools and 500 interleaved text streams', async () => {
    const rig = await openProviderTimelineRig({ schedule: () => () => {} })
    const assembler = rig.assembler
    const start = performance.now()
    assembler.apply({ type: 'turn.open', turn: 'long', at: 1_000 })
    for (let index = 0; index < 2_000; index += 1) {
      expect(
        assembler.apply({
          type: 'item.open',
          item: `tool-${index}`,
          body: runningTool('read')
        }).admission.accepted
      ).toBe(true)
      if (index % 4 === 0) {
        expect(
          assembler.apply({
            type: 'text.delta',
            item: { id: `m${index / 4}` },
            channel: 'assistant',
            text: 'Read '
          }).admission.accepted
        ).toBe(true)
      }
      if (index % 100 === 99) {
        await rig.rows()
      }
    }
    const opened = performance.now()
    for (let index = 0; index < 2_000; index += 1) {
      expect(
        assembler.apply({
          type: 'item.close',
          item: `tool-${index}`,
          body: {
            ...runningTool('read'),
            state: 'completed',
            output: journalPayload('x'.repeat(4_096))
          }
        }).admission.accepted
      ).toBe(true)
      if (index % 4 === 0) {
        assembler.apply({
          type: 'text.delta',
          item: { id: `m${index / 4}` },
          channel: 'assistant',
          text: 'complete.'
        })
      }
      if (index % 100 === 99) {
        await rig.rows()
      }
    }
    expect(
      assembler.apply({ type: 'turn.end', turn: 'long', at: 2_000, state: 'completed' }).admission
        .accepted
    ).toBe(true)
    const rows = await rig.rows()
    expect(
      rows.filter((row) => row.body.kind === 'tool-call' && row.body.state === 'completed')
    ).toHaveLength(2_000)
    expect(rows.filter((row) => row.body.kind === 'message')).toHaveLength(500)
    expect(messageText((await rig.row(providerItemId('item', 'm499')))?.body)).toBe(
      'Read complete.'
    )
    expect(await rig.turn('long')).toMatchObject({ state: 'completed' })
    console.info(
      JSON.stringify({
        workload: '2000-tools-500-streams-4KiB-final-output',
        openMs: opened - start,
        finishMs: performance.now() - opened
      })
    )
  }, 60_000)
})
