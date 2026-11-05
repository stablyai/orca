import { describe, expect, it } from 'vitest'
import {
  buildHeadlessTerminalSplitLayout,
  countTerminalLayoutLeaves
} from './headless-terminal-split-layout'

describe('buildHeadlessTerminalSplitLayout (headless split persistence)', () => {
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

    expect(next.root).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: 'leaf-a' },
        second: { type: 'leaf', leafId: 'leaf-c' }
      },
      second: { type: 'leaf', leafId: 'leaf-b' }
    })
    expect(countTerminalLayoutLeaves(next.root)).toBe(3)
    expect(next.ptyIdsByLeafId).toEqual({
      'leaf-a': 'pty-a',
      'leaf-b': 'pty-b',
      'leaf-c': 'pty-c'
    })
  })
})
