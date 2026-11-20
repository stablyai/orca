import { describe, expect, it } from 'vitest'
import {
  followTerminalRows,
  resolveTerminalPaneHandles,
  withReplacedTerminalHandles,
  type TerminalRowHandles
} from './mobile-terminal-pane-layout'

describe('split view across a host pane restart', () => {
  it('keeps both panes when the host gives one row a new terminal after a pending gap', () => {
    let rows: TerminalRowHandles = new Map()
    let pair: readonly string[] | null = ['term-a', 'term-b']
    const apply = (snapshot: { id: string; terminal: string | null }[]) => {
      const followed = followTerminalRows(
        rows,
        snapshot.map((row) => ({ type: 'terminal', ...row }))
      )
      rows = followed.handles
      pair = withReplacedTerminalHandles(pair, followed.replaced)
    }

    apply([
      { id: 'tab-1::leaf-a', terminal: 'term-a' },
      { id: 'tab-1::leaf-b', terminal: 'term-b' }
    ])
    apply([
      { id: 'tab-1::leaf-a', terminal: 'term-a' },
      { id: 'tab-1::leaf-b', terminal: null }
    ])
    apply([
      { id: 'tab-1::leaf-a', terminal: 'term-a' },
      { id: 'tab-1::leaf-b', terminal: 'term-b2' }
    ])

    expect(resolveTerminalPaneHandles('term-a', pair, ['term-a', 'term-b2'])).toEqual([
      'term-a',
      'term-b2'
    ])
  })
})
