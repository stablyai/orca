import { describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import {
  buildAgentRowLineageTree,
  flattenAgentRowLineage,
  type AgentRowNode
} from './agent-row-lineage'

function row(paneKey: string, parentPaneKey: string | null): RuntimeWorktreeAgentRow {
  return {
    paneKey,
    parentPaneKey,
    state: 'working',
    agentType: 'claude',
    prompt: '',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 0,
    updatedAt: 0
  }
}

// Frozen pre-optimization traversal: duplicate pane keys may be emitted on distinct branches.
function legacyFlatten(rows: readonly RuntimeWorktreeAgentRow[]): AgentRowNode[] {
  const { rootRows, childrenByParentPaneKey } = buildAgentRowLineageTree(rows)
  const out: AgentRowNode[] = []
  const seen = new Set<string>()
  const visit = (agent: RuntimeWorktreeAgentRow, depth: number, ancestors: ReadonlySet<string>) => {
    if (ancestors.has(agent.paneKey)) {
      return
    }
    seen.add(agent.paneKey)
    out.push({ row: agent, depth, children: [] })
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(agent.paneKey)
    for (const child of childrenByParentPaneKey.get(agent.paneKey) ?? []) {
      visit(child, depth + 1, nextAncestors)
    }
  }
  for (const root of rootRows) {
    visit(root, 0, new Set())
  }
  for (const agent of rows) {
    if (!seen.has(agent.paneKey)) {
      seen.add(agent.paneKey)
      out.push({ row: agent, depth: 0, children: [] })
    }
  }
  return out
}

describe('agent lineage traversal parity', () => {
  it('matches the previous traversal across cycles, dangling parents, duplicates, and input order', () => {
    const variants = ['a', 'b', 'c'].flatMap((paneKey) =>
      [null, 'a', 'b', 'c', 'missing'].map((parentPaneKey) => row(paneKey, parentPaneKey))
    )
    expect(flattenAgentRowLineage([])).toEqual(legacyFlatten([]))
    for (const first of variants) {
      for (const second of variants) {
        for (const third of variants) {
          const rows = [first, second, third]
          const expected = legacyFlatten(rows)
          const actual = flattenAgentRowLineage(rows)
          expect(actual).toEqual(expected)
          actual.forEach((node, index) => expect(node.row).toBe(expected[index]?.row))
        }
      }
    }
  })

  it('releases the ancestor path between duplicate roots and sibling branches', () => {
    const firstRoot = row('root', null)
    const secondRoot = row('root', null)
    const firstChild = row('child', 'root')
    const secondChild = row('child', 'root')
    const grandchild = row('grandchild', 'child')
    const rows = [firstRoot, firstChild, secondChild, grandchild, secondRoot]
    const actual = flattenAgentRowLineage(rows)
    expect(actual).toEqual(legacyFlatten(rows))
    expect(actual.map((node) => [rows.indexOf(node.row), node.depth])).toEqual([
      [0, 0],
      [1, 1],
      [3, 2],
      [2, 1],
      [3, 2],
      [4, 0],
      [1, 1],
      [3, 2],
      [2, 1],
      [3, 2]
    ])
  })

  it('copies no ancestor members while traversing a long lineage', () => {
    const rows = Array.from({ length: 512 }, (_, index) =>
      row(`pane-${index}`, index === 0 ? null : `pane-${index - 1}`)
    )
    const NativeSet = globalThis.Set
    let copiedMembers = 0
    class ObservedSet<T> extends NativeSet<T> {
      constructor(values?: Iterable<T> | null) {
        super()
        if (values) {
          for (const value of values) {
            copiedMembers += 1
            this.add(value)
          }
        }
      }
    }
    vi.stubGlobal('Set', ObservedSet)
    let actual: AgentRowNode[]
    try {
      actual = flattenAgentRowLineage(rows)
    } finally {
      vi.unstubAllGlobals()
    }
    expect(copiedMembers).toBe(0)
    expect(actual.map((node) => [node.row.paneKey, node.depth])).toEqual(
      rows.map((agent, index) => [agent.paneKey, index])
    )
  })
})
