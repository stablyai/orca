import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import {
  resolveTerminalCloseTarget,
  type TerminalCloseLayoutCopies
} from './terminal-surface-close'

const PANE = { kind: 'pane', tabId: 'tab-1', leafId: 'leaf-a' } as const

function layout(...leafIds: string[]): TerminalLayoutSnapshot {
  const [first, second] = leafIds
  return {
    root:
      first === undefined
        ? null
        : second === undefined
          ? { type: 'leaf', leafId: first }
          : {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: first },
              second: { type: 'leaf', leafId: second }
            },
    activeLeafId: first ?? null,
    expandedLeafId: null
  }
}

function copies(overrides: Partial<TerminalCloseLayoutCopies>): TerminalCloseLayoutCopies {
  return {
    rendererListsTab: false,
    snapshotRows: [],
    graphLeafIds: [],
    sessionLayout: undefined,
    ...overrides
  }
}

describe('resolveTerminalCloseTarget', () => {
  it('never widens a pane close when the owner copy records no panes', () => {
    // A renderer tab registered before its panes, with nothing published for it yet.
    expect(resolveTerminalCloseTarget(PANE, copies({ rendererListsTab: true }))).toBe('absent')
    // A main-owned tab whose layout was saved before its pane mounted, and no other copy.
    expect(resolveTerminalCloseTarget(PANE, copies({ sessionLayout: layout() }))).toBe('absent')
  })

  it("closes the tab only when a copy positively shows this pane as the tab's one pane", () => {
    const cases: [string, Partial<TerminalCloseLayoutCopies>][] = [
      ['renderer graph', { rendererListsTab: true, graphLeafIds: ['leaf-a'] }],
      [
        'renderer rows with no layout or graph panes',
        { rendererListsTab: true, snapshotRows: [{ leafId: 'leaf-a' }] }
      ],
      ['main session layout', { sessionLayout: layout('leaf-a') }],
      [
        'rows published for a main-owned tab whose saved layout is empty',
        { sessionLayout: layout(), snapshotRows: [{ leafId: 'leaf-a', parentLayout: layout() }] }
      ]
    ]
    for (const [name, overrides] of cases) {
      expect([name, resolveTerminalCloseTarget(PANE, copies(overrides))]).toEqual([
        name,
        'last-pane'
      ])
    }
  })

  it('reads past an empty copy to one that records the split', () => {
    expect(
      resolveTerminalCloseTarget(
        PANE,
        copies({
          sessionLayout: layout(),
          snapshotRows: [{ leafId: 'leaf-a', parentLayout: layout('leaf-a', 'leaf-b') }]
        })
      )
    ).toBe('pane')
  })

  it('treats a pane the owner copy lacks as absent', () => {
    expect(
      resolveTerminalCloseTarget(PANE, copies({ rendererListsTab: true, graphLeafIds: ['leaf-b'] }))
    ).toBe('absent')
  })
})
