import type { ComputerSnapshotResult } from '../../shared/runtime-types'
import {
  joinComputerTreeText,
  parseComputerTreeText,
  type ComputerTreeElement
} from '../../shared/computer-use-tree-text'

const MAX_BASELINES = 32
// Matches the provider snapshot caches: older element indexes are refused by actions anyway.
const MAX_BASELINE_AGE_MS = 2 * 60 * 1000
// A diff that rewrites most of the tree is harder to read than the tree itself.
const MAX_DIFF_TO_FULL_RATIO = 0.5

type ComputerTreeDiff = { text: string; changed: number; added: number; removed: number }

// Added or moved controls need the full tree so omitted lines cannot hide their location.
export function diffComputerTreeText(previous: string, next: string): ComputerTreeDiff | null {
  const before = parseComputerTreeText(previous)
  const after = parseComputerTreeText(next)
  if (before.elements.length === 0 || after.elements.length === 0) {
    return null
  }
  const beforeParents = elementParents(before.elements)
  const afterParents = elementParents(after.elements)
  const afterIndexes = new Set(after.elements.map((element) => element.index))
  const retainedBefore = before.elements.filter((element) => afterIndexes.has(element.index))
  const body: string[] = []
  let changed = 0
  for (const [position, element] of after.elements.entries()) {
    const old = retainedBefore[position]
    if (
      !old ||
      old.index !== element.index ||
      old.depth !== element.depth ||
      beforeParents.get(element.index) !== afterParents.get(element.index)
    ) {
      return null
    }
    if (old.lines.join('\n') !== element.lines.join('\n')) {
      changed += 1
      body.push(...element.lines.map((line) => `~ ${line}`))
    }
  }
  const removedIndexes = before.elements
    .map((element) => element.index)
    .filter((index) => !afterIndexes.has(index))
  if (removedIndexes.length > 0) {
    body.push(`- ${formatIndexRanges(removedIndexes)}`)
  }
  const summary = { changed, added: 0, removed: removedIndexes.length }
  if (body.length === 0) {
    return {
      ...summary,
      text: joinComputerTreeText(
        after.header,
        ['No change in the accessibility tree since the previous snapshot.'],
        after.footer
      )
    }
  }
  const text = joinComputerTreeText(
    after.header,
    [
      'Changes since the previous snapshot (~ changed, - removed). Unchanged elements are omitted and keep their indexes.',
      ...body
    ],
    after.footer
  )
  return text.length > next.length * MAX_DIFF_TO_FULL_RATIO ? null : { ...summary, text }
}

function elementParents(elements: ComputerTreeElement[]): Map<number, number | undefined> {
  const parents = new Map<number, number | undefined>()
  const path: number[] = []
  for (const element of elements) {
    path.length = Math.min(path.length, element.depth)
    parents.set(element.index, path.at(-1))
    path[element.depth] = element.index
  }
  return parents
}

function formatIndexRanges(indexes: number[]): string {
  const sorted = [...indexes].sort((a, b) => a - b)
  const ranges: string[] = []
  let start = sorted[0]
  let end = start
  for (const index of sorted.slice(1)) {
    if (index === end + 1) {
      end = index
      continue
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`)
    start = index
    end = index
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`)
  return ranges.join(', ')
}

type Baseline = {
  windowKey: string
  snapshotId: string
  treeText: string
  createdAtMs: number
}

// Remembers the last full tree returned per snapshot namespace and app process.
export class ComputerTreeBaselines {
  private readonly entries = new Map<string, Baseline>()

  apply<T extends ComputerSnapshotResult>(params: Record<string, unknown>, result: T): T {
    const { snapshot } = result
    const key = baselineKey(params, snapshot.app.pid)
    const windowKey = snapshotWindowKey(snapshot.window)
    this.prune()
    const previous = this.entries.get(key)
    this.entries.delete(key)
    this.entries.set(key, {
      windowKey,
      snapshotId: snapshot.id,
      treeText: snapshot.treeText,
      createdAtMs: Date.now()
    })
    if (params.treeDiff !== true || !previous || previous.windowKey !== windowKey) {
      return result
    }
    const diff = diffComputerTreeText(previous.treeText, snapshot.treeText)
    if (!diff) {
      return result
    }
    const { text, ...summary } = diff
    return {
      ...result,
      snapshot: {
        ...snapshot,
        treeText: text,
        treeDiff: { baseSnapshotId: previous.snapshotId, ...summary }
      }
    }
  }

  private prune(): void {
    const cutoff = Date.now() - MAX_BASELINE_AGE_MS
    for (const [key, entry] of this.entries) {
      if (this.entries.size > MAX_BASELINES || entry.createdAtMs < cutoff) {
        this.entries.delete(key)
      }
    }
  }
}

function baselineKey(params: Record<string, unknown>, pid: number): string {
  const namespace =
    typeof params.session === 'string' && params.session
      ? `session:${params.session}`
      : typeof params.worktree === 'string' && params.worktree
        ? `worktree:${params.worktree}`
        : 'default'
  return `${namespace}\u0000${pid}`
}

function snapshotWindowKey(window: ComputerSnapshotResult['snapshot']['window']): string {
  if (window.id !== null && window.id !== undefined) {
    return `id:${window.id}`
  }
  return window.index !== null && window.index !== undefined ? `index:${window.index}` : 'window'
}
