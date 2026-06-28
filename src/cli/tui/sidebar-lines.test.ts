import { describe, expect, it } from 'vitest'
import { buildSidebarLines, rowIndexAtScreenRow, tabAtScreenRow } from './sidebar-lines'
import { buildWorktreeSnapshot } from './worktree-snapshot'
import { makePsResult, makeWorktreeSummary } from './worktree-snapshot-fixtures'

const snapshot = buildWorktreeSnapshot(
  makePsResult([
    makeWorktreeSummary({ worktreeId: 'a', repoId: 'r1', repo: 'web-app' }),
    makeWorktreeSummary({ worktreeId: 'b', repoId: 'r1', repo: 'web-app' }),
    makeWorktreeSummary({ worktreeId: 'c', repoId: 'r2', repo: 'infra' })
  ])
)

describe('buildSidebarLines', () => {
  it('lays out header, per-group spacer/header, then rows', () => {
    const kinds = buildSidebarLines(snapshot).map((line) => line.kind)
    expect(kinds).toEqual(['header', 'spacer', 'group', 'row', 'row', 'spacer', 'group', 'row'])
  })

  it('assigns flattened selection indices to row lines in order', () => {
    const rows = buildSidebarLines(snapshot).filter((line) => line.kind === 'row')
    expect(rows.map((line) => (line.kind === 'row' ? line.index : -1))).toEqual([0, 1, 2])
    expect(rows.map((line) => (line.kind === 'row' ? line.worktreeId : ''))).toEqual([
      'a',
      'b',
      'c'
    ])
  })

  it('returns only the header for an empty/absent snapshot', () => {
    expect(buildSidebarLines(null).map((l) => l.kind)).toEqual(['header'])
  })

  const tab = (id: string, title: string, kind: 'terminal' | 'file' = 'terminal') => ({
    worktreeId: 'a',
    id,
    kind,
    title,
    terminalHandle: kind === 'terminal' ? id : null,
    relativePath: kind === 'file' ? title : null,
    url: null
  })

  it('nests session tabs under their worktree when expanded', () => {
    const tabs = {
      expanded: true,
      focusedTabId: 't-a2',
      tabsByWorktree: new Map([['a', [tab('t-a1', 'one'), tab('t-a2', 'two', 'file')]]])
    }
    const lines = buildSidebarLines(snapshot, undefined, tabs)
    // row(a) is followed by its two tab lines.
    expect(lines.map((l) => l.kind)).toEqual([
      'header',
      'spacer',
      'group',
      'row',
      'tab',
      'tab',
      'row',
      'spacer',
      'group',
      'row'
    ])
    const focused = lines.find((l) => l.kind === 'tab' && l.focused)
    expect(focused && focused.kind === 'tab' ? focused.id : null).toBe('t-a2')
  })

  it('omits tab lines when collapsed', () => {
    const tabs = { expanded: false, tabsByWorktree: new Map([['a', [tab('t-a1', 'one')]]]) }
    expect(buildSidebarLines(snapshot, undefined, tabs).some((l) => l.kind === 'tab')).toBe(false)
  })
})

describe('tabAtScreenRow', () => {
  const tab = (id: string, title: string) => ({
    worktreeId: 'a',
    id,
    kind: 'terminal' as const,
    title,
    terminalHandle: id,
    relativePath: null,
    url: null
  })

  it('resolves a tab line to its worktree index and id', () => {
    const lines = buildSidebarLines(snapshot, undefined, {
      expanded: true,
      tabsByWorktree: new Map([['a', [tab('t-a1', 'one')]]])
    })
    // header(0) spacer(1) group(2) row-a(3) tab(4) ...
    expect(tabAtScreenRow(lines, 4)).toEqual({ index: 0, worktreeId: 'a', id: 't-a1' })
    expect(tabAtScreenRow(lines, 3)).toBeNull()
  })
})

describe('rowIndexAtScreenRow', () => {
  it('maps a click screen row to the worktree-row index, mirroring the layout', () => {
    const lines = buildSidebarLines(snapshot)
    // screen rows: 0 header, 1 spacer, 2 group, 3 row(a), 4 row(b), 5 spacer, 6 group, 7 row(c)
    expect(rowIndexAtScreenRow(lines, 3)).toBe(0)
    expect(rowIndexAtScreenRow(lines, 4)).toBe(1)
    expect(rowIndexAtScreenRow(lines, 7)).toBe(2)
  })

  it('returns null for header/group/spacer/gutter rows', () => {
    const lines = buildSidebarLines(snapshot)
    expect(rowIndexAtScreenRow(lines, 0)).toBeNull()
    expect(rowIndexAtScreenRow(lines, 2)).toBeNull()
    expect(rowIndexAtScreenRow(lines, 99)).toBeNull()
  })
})
