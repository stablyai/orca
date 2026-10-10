import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MAX_SUBAGENT_FIELD_CHARS } from '../../shared/native-chat-subagent-summary'
import { isSubagentGroupBlock, type NativeChatSubagentState } from '../../shared/native-chat-types'
import type { AcpSubagentUpdate } from './acp-dialects/acp-dialect'
import { grokSubagentNotification } from './acp-dialects/grok-subagents'
import { AcpSubagentTimeline } from './acp-subagent-timeline'

const retainedSchema = z.object({
  groups: z.map(
    z.string(),
    z.object({
      entries: z.map(z.string(), z.object({ label: z.string() })),
      labelCounts: z.map(z.string(), z.number()),
      results: z.map(z.string(), z.string())
    })
  ),
  groupOf: z.map(z.string(), z.string()),
  settledIds: z.object({ size: z.number() })
})

function spawnGroups(
  timeline: AcpSubagentTimeline,
  count: number,
  state: NativeChatSubagentState = 'working'
) {
  for (let index = 0; index < count; index++) {
    timeline.translate(
      [{ id: `child-${index}`, turn: `turn-${index}`, state }],
      { thread: 'parent', turn: `turn-${index}` },
      index
    )
  }
}

describe('ACP subagent retention', () => {
  it('keeps every live owner beyond both former cache limits and releases newly settled groups', () => {
    const timeline = new AcpSubagentTimeline()
    for (let group = 0; group < 33; group++) {
      timeline.translate(
        Array.from({ length: 64 }, (_, child): AcpSubagentUpdate => ({
          id: `${group}:${child}`,
          turn: `turn-${group}`,
          state: 'working'
        })),
        { thread: 'parent' },
        group
      )
    }
    expect(timeline.has('0:0')).toBe(true)
    expect(timeline.has('32:63')).toBe(true)
    expect(retainedSchema.parse(timeline).groupOf.size).toBe(33 * 64)
    timeline.translate(
      Array.from({ length: 63 }, (_, child): AcpSubagentUpdate => ({
        id: `0:${child}`,
        state: 'completed',
        result: `Answer ${child}`
      })),
      { thread: 'parent' },
      100
    )
    expect(retainedSchema.parse(timeline).groups.size).toBe(33)
    expect(retainedSchema.parse(timeline).groups.get('turn-0')?.results.size).toBe(63)
    const events = timeline.translate(
      [{ id: '0:63', state: 'completed', result: 'Last sibling' }],
      { thread: 'parent', turn: 'later' },
      101
    )
    expect(events.map((event) => event.type === 'item.update' && event.join?.turn)).toEqual([
      'turn-0',
      'turn-0'
    ])
    const retained = retainedSchema.parse(timeline)
    expect(retained.groups.size).toBe(32)
    expect(retained.groups.has('turn-0')).toBe(false)
    expect(retained.groupOf.has('0:0')).toBe(false)
    expect(timeline.has('0:0')).toBe(true)
    expect(timeline.translate([{ id: '0:0', state: 'working' }], {}, 102)).toEqual([])
  })

  it('bounds settled history and evicted child ids while keeping live groups', () => {
    const timeline = new AcpSubagentTimeline()
    timeline.translate([{ id: 'live', turn: 'original' }], {}, 0)
    for (let group = 0; group < 65; group++) {
      timeline.translate(
        Array.from({ length: 64 }, (_, child): AcpSubagentUpdate => ({
          id: `${group}:${child}`,
          turn: `turn-${group}`,
          state: 'completed',
          result: 'Answer'
        })),
        {},
        group + 1
      )
    }
    const retained = retainedSchema.parse(timeline)
    expect(retained.groups.size).toBe(32)
    expect(retained.groupOf.size).toBe(31 * 64 + 1)
    expect(
      [...retained.groups.values()].reduce((total, group) => total + group.results.size, 0)
    ).toBe(31 * 64)
    expect(retained.settledIds.size).toBe(32 * 64)
    expect(timeline.has('live')).toBe(true)
    expect(timeline.has('0:0')).toBe(false)
    expect(timeline.has('33:0')).toBe(true)
    expect(timeline.translate([{ id: '33:0', state: 'working' }], {}, 2200)).toEqual([])
  })

  it('bounds retained descriptions and count keys, preserving ordinary duplicate labels and clipped distinctions', () => {
    const timeline = new AcpSubagentTimeline()
    const description = 'A'.repeat(1024 * 1024)
    const updates = ['large-1', 'large-2'].flatMap((id) => {
      const update = grokSubagentNotification({
        sessionUpdate: 'subagent_spawned',
        subagent_id: id,
        description
      })
      return update ? [update] : []
    })
    const events = timeline.translate(
      [...updates, { id: 'normal-1', label: 'Review' }, { id: 'normal-2', label: 'Review' }],
      { turn: 'turn' },
      0
    )
    const retained = retainedSchema.parse(timeline).groups.get('turn')
    expect(retained).toBeDefined()
    const labels = [...(retained?.entries.values() ?? [])].map((entry) => entry.label)
    expect(labels.every((label) => label.length <= MAX_SUBAGENT_FIELD_CHARS)).toBe(true)
    expect(
      [...(retained?.labelCounts.keys() ?? [])].every(
        (key) => key.length <= MAX_SUBAGENT_FIELD_CHARS
      )
    ).toBe(true)
    expect(new Set(labels).size).toBe(4)
    expect(labels.slice(2)).toEqual(['Review', 'Review 2'])
    const emitted = events.flatMap((event) =>
      event.type === 'item.update' && event.body.kind === 'message'
        ? event.body.blocks.filter(isSubagentGroupBlock).flatMap((group) => group.agents)
        : []
    )
    expect(emitted.map((entry) => entry.label)).toEqual(labels)
  })

  it('drops ownership and cached replies on disposal even if the producer continues', () => {
    const timeline = new AcpSubagentTimeline()
    spawnGroups(timeline, 33)
    timeline.translate([{ id: 'child-0', state: 'completed', result: 'Answer' }], {}, 100)
    timeline.dispose()
    const retained = retainedSchema.parse(timeline)
    expect(retained.groups.size).toBe(0)
    expect(retained.groupOf.size).toBe(0)
    expect(retained.settledIds.size).toBe(0)
    expect(timeline.translate([{ id: 'child-1', tokens: 9 }, { id: 'new' }], {}, 101)).toEqual([])
    expect(retainedSchema.parse(timeline).groups.size).toBe(0)
  })
})
