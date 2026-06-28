import { describe, expect, it } from 'vitest'
import {
  clampFileIndex,
  emptyFileBrowser,
  fileBrowserRows,
  rowIndexAtBodyRow,
  selectedRow,
  visibleTreeRows,
  type FileBrowserState
} from './file-browser'

function state(over: Partial<FileBrowserState> = {}): FileBrowserState {
  return {
    open: true,
    files: [
      { relativePath: 'src/a.ts', basename: 'a.ts' },
      { relativePath: 'src/sub/b.ts', basename: 'b.ts' },
      { relativePath: 'readme.md', basename: 'readme.md' }
    ],
    expanded: new Set(),
    index: 0,
    ...over
  }
}

describe('visibleTreeRows', () => {
  it('shows top-level folders before files, collapsed by default', () => {
    expect(visibleTreeRows(state()).map((r) => `${r.kind}:${r.name}`)).toEqual([
      'dir:src',
      'file:readme.md'
    ])
  })

  it('descends into expanded folders and indents children', () => {
    const rows = visibleTreeRows(state({ expanded: new Set(['src']) }))
    // Folders sort before files, so sub/ precedes a.ts within src/.
    expect(rows.map((r) => `${r.name}@${r.depth}`)).toEqual([
      'src@0',
      'sub@1',
      'a.ts@1',
      'readme.md@0'
    ])
  })
})

describe('selectedRow / clampFileIndex', () => {
  it('clamps and resolves the selected row', () => {
    expect(clampFileIndex(state({ index: 99 }))).toBe(1)
    expect(selectedRow(state({ expanded: new Set(['src']), index: 1 }))?.name).toBe('sub')
  })
})

describe('rowIndexAtBodyRow', () => {
  it('maps a body row to a visible-row index within the window', () => {
    expect(rowIndexAtBodyRow(state(), 0, 10)).toBe(0)
    expect(rowIndexAtBodyRow(state(), 1, 10)).toBe(1)
    expect(rowIndexAtBodyRow(state(), 5, 10)).toBeNull()
  })
})

describe('fileBrowserRows', () => {
  it('renders a header and the windowed tree at the given size', () => {
    const rows = fileBrowserRows(state({ expanded: new Set(['src']) }), 30, 6, false)
    expect(rows).toHaveLength(6)
    expect(rows[0]).toContain('Files')
    expect(rows.join('\n')).toContain('src')
    expect(rows.join('\n')).toContain('a.ts')
  })

  it('shows nothing but chrome when empty', () => {
    expect(fileBrowserRows(emptyFileBrowser(), 20, 4, false)).toHaveLength(4)
  })
})
