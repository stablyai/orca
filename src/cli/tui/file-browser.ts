import { style } from './ansi-control'
import { fitCells } from './text-width'

export type FileEntry = { relativePath: string; basename: string }

/** A flattened, currently-visible tree row (a folder or a file). */
export type TreeRow = { kind: 'dir' | 'file'; path: string; name: string; depth: number }

/** State of the Files browser: the worktree's flat file list (from files.list),
 *  the set of expanded folder paths, and the selected visible-row index. */
export type FileBrowserState = {
  open: boolean
  files: FileEntry[]
  expanded: Set<string>
  index: number
}

export function emptyFileBrowser(): FileBrowserState {
  return { open: false, files: [], expanded: new Set(), index: 0 }
}

type Child = { name: string; path: string; isDir: boolean }

// The file list only changes when files.list is re-fetched, so cache the built
// tree by the list's identity — visibleTreeRows runs on every keystroke/click.
const treeCache = new WeakMap<readonly FileEntry[], Map<string, Child[]>>()

function childrenByParent(files: readonly FileEntry[]): Map<string, Child[]> {
  const cached = treeCache.get(files)
  if (cached) {
    return cached
  }
  const built = buildChildrenByParent(files)
  treeCache.set(files, built)
  return built
}

/** Group every file path into its parent's child list, materializing the
 *  intermediate folders. Folders sort before files, then alphabetically. */
function buildChildrenByParent(files: readonly FileEntry[]): Map<string, Child[]> {
  const buckets = new Map<string, Map<string, Child>>()
  const bucket = (parent: string): Map<string, Child> => {
    const existing = buckets.get(parent)
    if (existing) {
      return existing
    }
    const created = new Map<string, Child>()
    buckets.set(parent, created)
    return created
  }
  for (const file of files) {
    const parts = file.relativePath.split('/').filter(Boolean)
    let parent = ''
    parts.forEach((name, i) => {
      const path = parent ? `${parent}/${name}` : name
      const isDir = i < parts.length - 1
      const into = bucket(parent)
      if (!into.has(name)) {
        into.set(name, { name, path, isDir })
      }
      parent = path
    })
  }
  const out = new Map<string, Child[]>()
  for (const [parent, children] of buckets) {
    out.set(
      parent,
      [...children.values()].sort((a, b) =>
        a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1
      )
    )
  }
  return out
}

/** The visible rows: every top-level entry, descending into a folder only when
 *  its path is in `expanded`. */
export function visibleTreeRows(state: FileBrowserState): TreeRow[] {
  const children = childrenByParent(state.files)
  const rows: TreeRow[] = []
  const walk = (parent: string, depth: number): void => {
    for (const child of children.get(parent) ?? []) {
      rows.push({ kind: child.isDir ? 'dir' : 'file', path: child.path, name: child.name, depth })
      if (child.isDir && state.expanded.has(child.path)) {
        walk(child.path, depth + 1)
      }
    }
  }
  walk('', 0)
  return rows
}

/** Clamp an index into the visible rows. */
export function clampFileIndex(state: FileBrowserState, rows = visibleTreeRows(state)): number {
  return rows.length === 0 ? 0 : Math.min(Math.max(state.index, 0), rows.length - 1)
}

/** The currently-selected row, or null. */
export function selectedRow(state: FileBrowserState): TreeRow | null {
  const rows = visibleTreeRows(state)
  return rows[clampFileIndex(state, rows)] ?? null
}

/** Map a 0-based row within the panel body (below the header) to a visible-row
 *  index, honoring the scroll window — for click-to-open. */
export function rowIndexAtBodyRow(
  state: FileBrowserState,
  bodyRow: number,
  bodyHeight: number
): number | null {
  const rows = visibleTreeRows(state)
  const start = windowStartFor(clampFileIndex(state, rows), rows.length, bodyHeight)
  const index = start + bodyRow
  return index >= 0 && index < rows.length ? index : null
}

function windowStartFor(selected: number, total: number, capacity: number): number {
  if (capacity <= 0 || total <= capacity) {
    return 0
  }
  return Math.min(Math.max(selected - Math.floor(capacity / 2), 0), total - capacity)
}

/** Render the right-side Files panel as exactly `height` rows of `width` cells:
 *  a header, then the windowed, indented tree (▾/▸ folders, files plain). */
export function fileBrowserRows(
  state: FileBrowserState,
  width: number,
  height: number,
  useColor: boolean
): string[] {
  const tree = visibleTreeRows(state)
  const selected = clampFileIndex(state, tree)
  // Leave a one-column right margin so the panel's edge is visible against the
  // screen edge; each row is content (w cells) + a trailing blank column.
  const w = Math.max(1, width - 1)
  const margin = (styled: string): string => `${styled} `
  const rows: string[] = [
    margin(
      style(
        fitCells(' Files  (↑↓ move · → open · ← close · f exit)', w),
        { bg: 'white', fg: 'black', bold: true },
        useColor
      )
    )
  ]
  const bodyHeight = Math.max(0, height - rows.length)
  const start = windowStartFor(selected, tree.length, bodyHeight)
  for (let i = 0; i < bodyHeight; i += 1) {
    const row = tree[start + i]
    if (!row) {
      rows.push(' '.repeat(width))
      continue
    }
    const indent = ' '.repeat(2 + row.depth * 2)
    const glyph = row.kind === 'dir' ? (state.expanded.has(row.path) ? '▾ ' : '▸ ') : '  '
    const isSel = start + i === selected
    rows.push(
      margin(
        style(
          fitCells(`${indent}${glyph}${row.name}`, w),
          isSel ? { inverse: true, bold: true } : row.kind === 'dir' ? { bold: true } : {},
          useColor
        )
      )
    )
  }
  return rows.slice(0, height)
}
