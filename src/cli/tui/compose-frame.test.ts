import { describe, expect, it } from 'vitest'
import { composeFrame, type FrameModel } from './compose-frame'
import { cellWidth } from './text-width'
import { buildWorktreeSnapshot, flattenWorktreeRows } from './worktree-snapshot'
import { worktreeIndicatorKind } from './agent-state-indicator'
import { makePsResult, makeWorktreeSummary } from './worktree-snapshot-fixtures'
import { emptyAnsiFrame } from './terminal-ansi-source'
import { emptyFileBrowser } from './file-browser'
import { sidebarWidthFor } from './tui-layout'

const snapshot = buildWorktreeSnapshot(
  makePsResult([
    makeWorktreeSummary({
      worktreeId: 'wt-1',
      displayName: 'feature/x',
      isActive: true,
      liveTerminalCount: 1
    })
  ])
)

function model(overrides: Partial<FrameModel> = {}): FrameModel {
  const rows = flattenWorktreeRows(snapshot)
  const columns = 100
  return {
    columns,
    rows: 24,
    isNarrow: false,
    narrowView: 'list',
    snapshot,
    worktreeRows: rows,
    selectedIndex: 0,
    selectedName: rows[0]?.displayName ?? '',
    sidebarWidth: sidebarWidthFor(columns),
    tabs: [
      {
        worktreeId: 'wt-1',
        id: 't1',
        kind: 'terminal',
        title: 'shell',
        terminalHandle: 'term_1',
        relativePath: null,
        url: null
      }
    ],
    tabsByWorktree: new Map([
      [
        'wt-1',
        [
          {
            worktreeId: 'wt-1',
            id: 't1',
            kind: 'terminal',
            title: 'shell',
            terminalHandle: 'term_1',
            relativePath: null,
            url: null
          }
        ]
      ]
    ]),
    tabsExpanded: false,
    focusedTabId: 't1',
    terminalFocused: false,
    editState: 'none',
    fileBrowser: emptyFileBrowser(),
    viewport: emptyAnsiFrame(),
    scrollOffset: 0,
    resolveKind: (row) => worktreeIndicatorKind(row.status, row.agents),
    platform: 'mac',
    context: 'feature/x',
    disconnected: false,
    error: null,
    useColor: true,
    overlay: { kind: 'none' },
    ...overrides
  }
}

describe('composeFrame', () => {
  it('produces one row per screen line, each exactly `columns` cells wide', () => {
    const frame = composeFrame(model())
    expect(frame).toHaveLength(24)
    for (const row of frame) {
      expect(cellWidth(row)).toBe(100)
    }
  })

  it('renders the header and the selected worktree in the sidebar', () => {
    const frame = composeFrame(model())
    expect(frame[0]).toContain('orca tui')
    expect(frame.join('\n')).toContain('feature/x')
  })

  it('stamps an overlay over the body when one is active', () => {
    const frame = composeFrame(model({ overlay: { kind: 'confirm', message: 'Remove?' } }))
    expect(frame.join('\n')).toContain('Remove?')
    expect(frame.join('\n')).toContain('Confirm')
  })

  it('shows split focus bars: brand on top, nav + terminal hints on the footer', () => {
    const frame = composeFrame(model())
    expect(frame[0]).toContain('orca tui')
    const joined = frame.join('\n')
    expect(joined).toContain('move')
    expect(joined).toContain('terminal')
  })

  it('marks the divider with a heavy bar when the terminal is focused', () => {
    expect(composeFrame(model({ terminalFocused: false })).some((r) => r.includes('┃'))).toBe(false)
    expect(composeFrame(model({ terminalFocused: true })).some((r) => r.includes('┃'))).toBe(true)
  })

  it('shows the back button in the narrow terminal view', () => {
    const frame = composeFrame(model({ isNarrow: true, narrowView: 'terminal', columns: 50 }))
    expect(frame[0]).toContain('workspaces')
  })
})
