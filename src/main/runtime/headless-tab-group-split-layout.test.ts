import { describe, expect, it } from 'vitest'
import {
  buildHeadlessTabGroupMove,
  buildHeadlessTabGroupSplit,
  collectTabGroupLayoutGroupIds,
  removeTabGroupLayoutLeaf
} from './headless-tab-group-split-layout'

const group = (id: string, tabs: string[], activeTabId = tabs[0] ?? null) => ({
  id,
  activeTabId,
  tabOrder: tabs
})

describe('buildHeadlessTabGroupSplit', () => {
  it('splits a tab into a new group to the right (horizontal, second)', () => {
    const result = buildHeadlessTabGroupSplit({
      groups: [group('g1', ['a', 'b'])],
      layout: { type: 'leaf', groupId: 'g1' },
      tabId: 'b',
      targetGroupId: 'g1',
      splitDirection: 'right',
      newGroupId: 'g2'
    })
    expect(result).not.toBeNull()
    expect(result!.groups).toHaveLength(2)
    expect(result!.groups.find((g) => g.id === 'g1')!.tabOrder).toEqual(['a'])
    expect(result!.groups.find((g) => g.id === 'g2')!.tabOrder).toEqual(['b'])
    expect(result!.layout).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'g1' },
      second: { type: 'leaf', groupId: 'g2' },
      ratio: 0.5
    })
  })

  it('places the new group first when splitting left', () => {
    const result = buildHeadlessTabGroupSplit({
      groups: [group('g1', ['a', 'b'])],
      layout: { type: 'leaf', groupId: 'g1' },
      tabId: 'b',
      targetGroupId: 'g1',
      splitDirection: 'left',
      newGroupId: 'g2'
    })
    expect(result!.layout).toMatchObject({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'g2' },
      second: { type: 'leaf', groupId: 'g1' }
    })
  })

  it('uses a vertical split for up/down', () => {
    const down = buildHeadlessTabGroupSplit({
      groups: [group('g1', ['a', 'b'])],
      layout: { type: 'leaf', groupId: 'g1' },
      tabId: 'b',
      targetGroupId: 'g1',
      splitDirection: 'down',
      newGroupId: 'g2'
    })
    expect(down!.layout).toMatchObject({ type: 'split', direction: 'vertical' })
  })

  it('returns null when splitting the only tab off its own group (renderer no-op parity)', () => {
    const result = buildHeadlessTabGroupSplit({
      groups: [group('g1', ['a'])],
      layout: { type: 'leaf', groupId: 'g1' },
      tabId: 'a',
      targetGroupId: 'g1',
      splitDirection: 'right',
      newGroupId: 'g2'
    })
    expect(result).toBeNull()
  })

  it('returns null when the tab is not in any group', () => {
    expect(
      buildHeadlessTabGroupSplit({
        groups: [group('g1', ['a'])],
        layout: { type: 'leaf', groupId: 'g1' },
        tabId: 'missing',
        targetGroupId: 'g1',
        splitDirection: 'right',
        newGroupId: 'g2'
      })
    ).toBeNull()
  })

  it('moves the active tab out and reassigns source active to the survivor', () => {
    const result = buildHeadlessTabGroupSplit({
      groups: [group('g1', ['a', 'b'], 'b')],
      layout: { type: 'leaf', groupId: 'g1' },
      tabId: 'b',
      targetGroupId: 'g1',
      splitDirection: 'right',
      newGroupId: 'g2'
    })
    expect(result!.groups.find((g) => g.id === 'g1')!.activeTabId).toBe('a')
    expect(result!.groups.find((g) => g.id === 'g2')!.activeTabId).toBe('b')
  })

  it('collapses an emptied source group out of the layout when moving across groups', () => {
    // g2 holds only 'b'; moving 'b' into a new split off g1 empties g2.
    const result = buildHeadlessTabGroupSplit({
      groups: [group('g1', ['a']), group('g2', ['b'])],
      layout: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'g1' },
        second: { type: 'leaf', groupId: 'g2' }
      },
      tabId: 'b',
      targetGroupId: 'g1',
      splitDirection: 'right',
      newGroupId: 'g3'
    })
    const ids = result!.groups.map((g) => g.id).sort()
    expect(ids).toEqual(['g1', 'g3'])
    // g2 must not survive in the layout tree.
    expect([...collectTabGroupLayoutGroupIds(result!.layout)].sort()).toEqual(['g1', 'g3'])
  })

  it('synthesizes a leaf layout when none exists yet', () => {
    const result = buildHeadlessTabGroupSplit({
      groups: [group('g1', ['a', 'b'])],
      layout: null,
      tabId: 'b',
      targetGroupId: 'g1',
      splitDirection: 'right',
      newGroupId: 'g2'
    })
    expect(result!.layout).toMatchObject({ type: 'split' })
    expect([...collectTabGroupLayoutGroupIds(result!.layout)].sort()).toEqual(['g1', 'g2'])
  })
})

describe('buildHeadlessTabGroupMove', () => {
  const twoGroupLayout = {
    type: 'split' as const,
    direction: 'horizontal' as const,
    first: { type: 'leaf' as const, groupId: 'g1' },
    second: { type: 'leaf' as const, groupId: 'g2' }
  }

  it('moves a tab into an existing group at the given index', () => {
    const result = buildHeadlessTabGroupMove({
      groups: [group('g1', ['a', 'b']), group('g2', ['c'])],
      layout: twoGroupLayout,
      tabId: 'b',
      targetGroupId: 'g2',
      index: 0
    })
    expect(result!.groups.find((g) => g.id === 'g1')!.tabOrder).toEqual(['a'])
    expect(result!.groups.find((g) => g.id === 'g2')!.tabOrder).toEqual(['b', 'c'])
    expect(result!.groups.find((g) => g.id === 'g2')!.activeTabId).toBe('b')
  })

  it('collapses the source group out of the layout when the move empties it', () => {
    const result = buildHeadlessTabGroupMove({
      groups: [group('g1', ['a']), group('g2', ['b'])],
      layout: twoGroupLayout,
      tabId: 'a',
      targetGroupId: 'g2'
    })
    expect(result!.groups.map((g) => g.id)).toEqual(['g2'])
    expect(result!.layout).toEqual({ type: 'leaf', groupId: 'g2' })
  })

  it('returns null for a same-group move (renderer no-op)', () => {
    expect(
      buildHeadlessTabGroupMove({
        groups: [group('g1', ['a', 'b'])],
        layout: { type: 'leaf', groupId: 'g1' },
        tabId: 'b',
        targetGroupId: 'g1'
      })
    ).toBeNull()
  })

  it('returns null when the target group does not exist', () => {
    expect(
      buildHeadlessTabGroupMove({
        groups: [group('g1', ['a', 'b'])],
        layout: { type: 'leaf', groupId: 'g1' },
        tabId: 'b',
        targetGroupId: 'missing'
      })
    ).toBeNull()
  })
})

describe('removeTabGroupLayoutLeaf', () => {
  it('collapses a split into its sibling when a leaf is removed', () => {
    expect(
      removeTabGroupLayoutLeaf(
        {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'g1' },
          second: { type: 'leaf', groupId: 'g2' }
        },
        'g2'
      )
    ).toEqual({ type: 'leaf', groupId: 'g1' })
  })

  it('returns null when the last leaf is removed', () => {
    expect(removeTabGroupLayoutLeaf({ type: 'leaf', groupId: 'g1' }, 'g1')).toBeNull()
  })
})
