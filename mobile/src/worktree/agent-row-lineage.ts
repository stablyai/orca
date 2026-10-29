import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'

export type AgentRowNode = {
  row: RuntimeWorktreeAgentRow
  depth: number
  children: AgentRowNode[]
}

export type AgentRowLineageTree = {
  rootRows: RuntimeWorktreeAgentRow[]
  childrenByParentPaneKey: Map<string, RuntimeWorktreeAgentRow[]>
}

// Mirror desktop lineage using server-resolved parentPaneKey; guard cyclic and dangling metadata.
export function buildAgentRowLineageTree(
  rows: readonly RuntimeWorktreeAgentRow[]
): AgentRowLineageTree {
  const byPaneKey = new Map<string, RuntimeWorktreeAgentRow>()
  for (const row of rows) {
    if (!byPaneKey.has(row.paneKey)) {
      byPaneKey.set(row.paneKey, row)
    }
  }

  const childrenByParentPaneKey = new Map<string, RuntimeWorktreeAgentRow[]>()
  const childPaneKeys = new Set<string>()
  for (const row of rows) {
    const parentPaneKey = row.parentPaneKey
    // Invalid/self parents become roots so malformed metadata cannot hide rows.
    if (!parentPaneKey || parentPaneKey === row.paneKey || !byPaneKey.has(parentPaneKey)) {
      continue
    }
    childPaneKeys.add(row.paneKey)
    const siblings = childrenByParentPaneKey.get(parentPaneKey)
    if (siblings) {
      siblings.push(row)
    } else {
      childrenByParentPaneKey.set(parentPaneKey, [row])
    }
  }

  const rootRows = rows.filter((row) => !childPaneKeys.has(row.paneKey))
  if (rootRows.length === 0 && rows.length > 0) {
    // A closed cycle has no root; keep every participant visible.
    return { rootRows: [...rows], childrenByParentPaneKey: new Map() }
  }

  return { rootRows, childrenByParentPaneKey }
}

export function flattenAgentRowLineage(rows: readonly RuntimeWorktreeAgentRow[]): AgentRowNode[] {
  const { rootRows, childrenByParentPaneKey } = buildAgentRowLineageTree(rows)
  const out: AgentRowNode[] = []
  const seen = new Set<string>()
  const ancestors = new Set<string>()
  const visit = (row: RuntimeWorktreeAgentRow, depth: number) => {
    if (ancestors.has(row.paneKey)) {
      return
    }
    seen.add(row.paneKey)
    const node: AgentRowNode = { row, depth, children: [] }
    out.push(node)
    ancestors.add(row.paneKey)
    for (const child of childrenByParentPaneKey.get(row.paneKey) ?? []) {
      visit(child, depth + 1)
    }
    ancestors.delete(row.paneKey)
  }
  for (const root of rootRows) {
    visit(root, 0)
  }
  // Cycles beside a normal tree are unreachable from roots; emit unseen rows so none vanish.
  for (const row of rows) {
    if (!seen.has(row.paneKey)) {
      seen.add(row.paneKey)
      out.push({ row, depth: 0, children: [] })
    }
  }
  return out
}
