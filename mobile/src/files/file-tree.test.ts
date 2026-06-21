import { describe, expect, it } from 'vitest'
import { buildTree, flattenTree, isMarkdownPath, type MobileFileEntry } from './file-tree'

function entry(relativePath: string, kind: 'text' | 'binary' = 'text'): MobileFileEntry {
  return { relativePath, basename: relativePath.split('/').pop() ?? relativePath, kind }
}

describe('file-tree', () => {
  it('nests files under their directories', () => {
    const root = buildTree([entry('src/app.ts'), entry('src/lib/util.ts'), entry('readme.md')])
    expect(root.files.map((f) => f.relativePath)).toEqual(['readme.md'])
    expect(root.directories.get('src')?.directories.get('lib')?.files[0]?.relativePath).toBe(
      'src/lib/util.ts'
    )
  })

  it('flattens with directories before files and only expands open dirs', () => {
    const root = buildTree([entry('src/app.ts'), entry('zeta.txt')])
    const collapsed = flattenTree(root, new Set())
    expect(collapsed.map((r) => r.id)).toEqual(['dir:src', 'file:zeta.txt'])

    const expanded = flattenTree(root, new Set(['src']))
    expect(expanded.map((r) => r.id)).toEqual(['dir:src', 'file:src/app.ts', 'file:zeta.txt'])
  })

  it('preserves the binary kind on flattened rows', () => {
    const root = buildTree([entry('assets/logo.png', 'binary')])
    const rows = flattenTree(root, new Set(['assets']))
    expect(rows.find((r) => r.id === 'file:assets/logo.png')?.kind).toBe('binary')
  })

  it('detects markdown paths', () => {
    expect(isMarkdownPath('docs/readme.md')).toBe(true)
    expect(isMarkdownPath('notes.markdown')).toBe(true)
    expect(isMarkdownPath('app.ts')).toBe(false)
  })
})
