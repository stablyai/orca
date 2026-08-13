import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../shared/types'
import {
  buildHeadlessTerminalSplitLayout,
  countTerminalLayoutLeaves,
  terminalLayoutContainsLeaf
} from './headless-terminal-split-layout'

describe('terminalLayoutContainsLeaf', () => {
  it('requires the leaf in the layout tree', () => {
    expect(
      terminalLayoutContainsLeaf(
        {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: 'leaf-a' },
          second: { type: 'leaf', leafId: 'leaf-b' }
        },
        'leaf-b'
      )
    ).toBe(true)
    expect(terminalLayoutContainsLeaf({ type: 'leaf', leafId: 'leaf-a' }, 'leaf-b')).toBe(false)
  })
})

describe('buildHeadlessTerminalSplitLayout (headless split persistence)', () => {
  it('splits a single-leaf tab into a 2-leaf split tree', () => {
    const existing: TerminalLayoutSnapshot = {
      root: { type: 'leaf', leafId: 'leaf-a' },
      activeLeafId: 'leaf-a',
      expandedLeafId: null,
      ptyIdsByLeafId: { 'leaf-a': 'pty-a' }
    }
    const next = buildHeadlessTerminalSplitLayout(existing, {
      leafId: 'leaf-b',
      ptyId: 'pty-b',
      splitFromLeafId: 'leaf-a',
      direction: 'vertical'
    })
    expect(countTerminalLayoutLeaves(next.root)).toBe(2)
    expect(next.root).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: { type: 'leaf', leafId: 'leaf-b' }
    })
    expect(next.activeLeafId).toBe('leaf-b')
    expect(next.ptyIdsByLeafId).toEqual({ 'leaf-a': 'pty-a', 'leaf-b': 'pty-b' })
  })

  it('splits a nested leaf inside an existing split (split-of-a-split)', () => {
    const existing: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: 'leaf-a' },
        second: { type: 'leaf', leafId: 'leaf-b' }
      },
      activeLeafId: 'leaf-b',
      expandedLeafId: null,
      ptyIdsByLeafId: { 'leaf-a': 'pty-a', 'leaf-b': 'pty-b' }
    }
    const next = buildHeadlessTerminalSplitLayout(existing, {
      leafId: 'leaf-c',
      ptyId: 'pty-c',
      splitFromLeafId: 'leaf-b',
      direction: 'horizontal'
    })
    // 3 leaves total; the split happened at leaf-b, leaf-a untouched.
    expect(countTerminalLayoutLeaves(next.root)).toBe(3)
    expect(next.root).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: 'leaf-b' },
        second: { type: 'leaf', leafId: 'leaf-c' }
      }
    })
    expect(next.ptyIdsByLeafId).toEqual({
      'leaf-a': 'pty-a',
      'leaf-b': 'pty-b',
      'leaf-c': 'pty-c'
    })
  })

  it('synthesizes a split when there is no existing persisted layout', () => {
    const next = buildHeadlessTerminalSplitLayout(undefined, {
      leafId: 'leaf-b',
      ptyId: 'pty-b',
      splitFromLeafId: 'leaf-a',
      direction: 'horizontal'
    })
    expect(countTerminalLayoutLeaves(next.root)).toBe(2)
    expect(next.root).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: { type: 'leaf', leafId: 'leaf-b' }
    })
  })

  it('replaces the provisional admission leaf with the requested split direction', () => {
    const next = buildHeadlessTerminalSplitLayout(
      {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: 'leaf-a' },
          second: { type: 'leaf', leafId: 'leaf-c' }
        },
        activeLeafId: 'leaf-c',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-a': 'pty-a', 'leaf-c': 'provisional-pty' }
      },
      { leafId: 'leaf-c', ptyId: 'pty-c', splitFromLeafId: 'leaf-a', direction: 'horizontal' }
    )

    expect(next.root).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: 'leaf-a' },
      second: { type: 'leaf', leafId: 'leaf-c' }
    })
    expect(next.ptyIdsByLeafId).toEqual({ 'leaf-a': 'pty-a', 'leaf-c': 'pty-c' })
  })

  it('preserves a sibling committed by a concurrent split', () => {
    const next = buildHeadlessTerminalSplitLayout(
      {
        root: {
          type: 'split',
          direction: 'vertical',
          first: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: 'leaf-a' },
            second: { type: 'leaf', leafId: 'leaf-b' }
          },
          second: { type: 'leaf', leafId: 'leaf-c' }
        },
        activeLeafId: 'leaf-c',
        expandedLeafId: null,
        ptyIdsByLeafId: {
          'leaf-a': 'pty-a',
          'leaf-b': 'pty-b',
          'leaf-c': 'provisional-pty'
        }
      },
      { leafId: 'leaf-c', ptyId: 'pty-c', splitFromLeafId: 'leaf-a', direction: 'vertical' }
    )

    expect(countTerminalLayoutLeaves(next.root)).toBe(3)
    expect(next.ptyIdsByLeafId).toEqual({
      'leaf-a': 'pty-a',
      'leaf-b': 'pty-b',
      'leaf-c': 'pty-c'
    })
  })

  it('does not collapse — the persisted layout keeps both leaves (regression guard)', () => {
    // Why: the reported bug was the split collapsing back to one pane. After a
    // split, a rebuild reads this persisted layout, so it MUST stay multi-leaf.
    const afterSplit = buildHeadlessTerminalSplitLayout(
      {
        root: { type: 'leaf', leafId: 'leaf-a' },
        activeLeafId: 'leaf-a',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-a': 'pty-a' }
      },
      { leafId: 'leaf-b', ptyId: 'pty-b', splitFromLeafId: 'leaf-a', direction: 'vertical' }
    )
    expect(countTerminalLayoutLeaves(afterSplit.root)).toBeGreaterThan(1)
  })
})
