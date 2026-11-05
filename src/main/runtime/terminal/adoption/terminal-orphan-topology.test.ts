import { describe, expect, it } from 'vitest'
import { mergeTerminalOrphanGroupLayout } from './terminal-orphan-topology'

describe('terminal orphan topology', () => {
  it('keeps current host layout while preserving an unrelated proposed subtree', () => {
    expect(
      mergeTerminalOrphanGroupLayout({
        existingLayout: { type: 'leaf', groupId: 'group-live' },
        existingGroupIds: ['group-live'],
        proposedLayout: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.6,
          first: { type: 'leaf', groupId: 'group-old-left' },
          second: { type: 'leaf', groupId: 'group-old-right' }
        },
        proposedGroupIds: ['group-old-left', 'group-old-right'],
        mergedGroupIds: ['group-live', 'group-old-left', 'group-old-right']
      })
    ).toEqual({
      type: 'split',
      direction: 'vertical',
      ratio: 0.6,
      first: { type: 'leaf', groupId: 'group-live' },
      second: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.6,
        first: { type: 'leaf', groupId: 'group-old-left' },
        second: { type: 'leaf', groupId: 'group-old-right' }
      }
    })
  })

  it('grafts proposed groups beside their one current anchor without duplicating it', () => {
    expect(
      mergeTerminalOrphanGroupLayout({
        existingLayout: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', groupId: 'group-live' },
          second: { type: 'leaf', groupId: 'group-other' }
        },
        existingGroupIds: ['group-live', 'group-other'],
        proposedLayout: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.7,
          first: { type: 'leaf', groupId: 'group-live' },
          second: { type: 'leaf', groupId: 'group-recovered' }
        },
        proposedGroupIds: ['group-live', 'group-recovered'],
        mergedGroupIds: ['group-live', 'group-other', 'group-recovered']
      })
    ).toEqual({
      type: 'split',
      direction: 'vertical',
      first: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.7,
        first: { type: 'leaf', groupId: 'group-live' },
        second: { type: 'leaf', groupId: 'group-recovered' }
      },
      second: { type: 'leaf', groupId: 'group-other' }
    })
  })

  it('appends new groups when multiple shared anchors make placement ambiguous', () => {
    expect(
      mergeTerminalOrphanGroupLayout({
        existingLayout: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-a' },
          second: { type: 'leaf', groupId: 'group-b' }
        },
        existingGroupIds: ['group-a', 'group-b'],
        proposedLayout: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.7,
          first: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: 'group-a' },
            second: { type: 'leaf', groupId: 'group-b' }
          },
          second: { type: 'leaf', groupId: 'group-recovered' }
        },
        proposedGroupIds: ['group-a', 'group-b', 'group-recovered'],
        mergedGroupIds: ['group-a', 'group-b', 'group-recovered']
      })
    ).toEqual({
      type: 'split',
      direction: 'vertical',
      ratio: 0.7,
      first: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'group-a' },
        second: { type: 'leaf', groupId: 'group-b' }
      },
      second: { type: 'leaf', groupId: 'group-recovered' }
    })
  })
})
