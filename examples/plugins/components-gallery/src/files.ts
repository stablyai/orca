// A stand-in data source: 240 files served a page at a time, as a real backend would.
import type { TableSort } from 'orca'

export type FileRow = { path: string; name: string; kind: 'source' | 'test' | 'doc'; size: number }

const KINDS = ['source', 'test', 'doc'] as const

export const ALL_FILES: readonly FileRow[] = Array.from({ length: 240 }, (_, index) => {
  const kind = KINDS[index % KINDS.length]
  const name = `${kind}-${String(index).padStart(3, '0')}.${kind === 'doc' ? 'md' : 'ts'}`
  return { path: `src/${name}`, name, kind, size: (index * 7919) % 50_000 }
})

export const PAGE_SIZE = 50

export function sortedFiles(sort: TableSort): FileRow[] {
  const order = (a: FileRow, b: FileRow): number =>
    sort.column === 'size' ? a.size - b.size : a.name.localeCompare(b.name)
  return [...ALL_FILES].sort((a, b) => (sort.direction === 'asc' ? order(a, b) : order(b, a)))
}

/** Children of a folder, as a lazy Tree would fetch them. */
export function folderChildren(key: string): { key: string; label: string; icon: 'file' }[] {
  return ['index.ts', 'main.ts', 'util.ts'].map((name) => ({
    key: `${key}/${name}`,
    label: name,
    icon: 'file'
  }))
}
