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

// Mirrors the desktop buildAgentRowLineageTree: groups a flat agent list into a
// spawn tree by parentPaneKey. The wire rows already carry a resolved
// parentPaneKey (the server reads the orchestration db), so this only has to
// group and guard against malformed (cyclic / dangling-parent) metadata.
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
    // Why: ignore a parent that points at the row itself or at a pane not in
    // this list — treat those as roots rather than dropping them.
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
    // Why: a closed cycle leaves no root. Keep every agent visible as a flat
    // root instead of hiding all participants.
    return { rootRows: [...rows], childrenByParentPaneKey: new Map() }
  }

  return { rootRows, childrenByParentPaneKey }
}

// Flattens the lineage tree into depth-tagged nodes in render order
// (parent immediately followed by its descendants). Cycle-guarded.
export function flattenAgentRowLineage(rows: readonly RuntimeWorktreeAgentRow[]): AgentRowNode[] {
  const { rootRows, childrenByParentPaneKey } = buildAgentRowLineageTree(rows)
  const out: AgentRowNode[] = []
  const seen = new Set<string>()
  const visit = (row: RuntimeWorktreeAgentRow, depth: number, ancestors: ReadonlySet<string>) => {
    if (ancestors.has(row.paneKey)) {
      return
    }
    seen.add(row.paneKey)
    const node: AgentRowNode = { row, depth, children: [] }
    out.push(node)
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(row.paneKey)
    for (const child of childrenByParentPaneKey.get(row.paneKey) ?? []) {
      visit(child, depth + 1, nextAncestors)
    }
  }
  for (const root of rootRows) {
    visit(root, 0, new Set())
  }
  // Why: a cyclic component that coexists with a normal rooted tree has no entry
  // in rootRows and is unreachable from any root, so it would silently vanish.
  // Surface any not-yet-emitted rows as depth-0 so every agent stays visible.
  for (const row of rows) {
    if (!seen.has(row.paneKey)) {
      seen.add(row.paneKey)
      out.push({ row, depth: 0, children: [] })
    }
  }
  return out
}
