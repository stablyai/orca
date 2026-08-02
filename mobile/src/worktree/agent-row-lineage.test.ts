import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { buildAgentRowLineageTree, flattenAgentRowLineage } from './agent-row-lineage'

function row(
  paneKey: string,
  parentPaneKey: string | null = null,
  overrides: Partial<RuntimeWorktreeAgentRow> = {}
): RuntimeWorktreeAgentRow {
  return {
    paneKey,
    parentPaneKey,
    state: 'working',
    agentType: 'claude',
    prompt: '',
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('buildAgentRowLineageTree', () => {
  it('groups children under their parent and leaves roots flat', () => {
    const rows = [row('a'), row('b', 'a'), row('c', 'a'), row('d')]
    const { rootRows, childrenByParentPaneKey } = buildAgentRowLineageTree(rows)

    expect(rootRows.map((r) => r.paneKey)).toEqual(['a', 'd'])
    expect(childrenByParentPaneKey.get('a')?.map((r) => r.paneKey)).toEqual(['b', 'c'])
  })

  it('treats a dangling parent pointer as a root', () => {
    const rows = [row('a', 'missing-parent'), row('b')]
    const { rootRows } = buildAgentRowLineageTree(rows)

    expect(rootRows.map((r) => r.paneKey).sort()).toEqual(['a', 'b'])
  })

  it('keeps all rows visible when the parent links form a cycle', () => {
    const rows = [row('a', 'b'), row('b', 'a')]
    const { rootRows, childrenByParentPaneKey } = buildAgentRowLineageTree(rows)

    expect(rootRows.map((r) => r.paneKey).sort()).toEqual(['a', 'b'])
    expect(childrenByParentPaneKey.size).toBe(0)
  })

  it('ignores a self-referential parent', () => {
    const { rootRows } = buildAgentRowLineageTree([row('a', 'a')])
    expect(rootRows.map((r) => r.paneKey)).toEqual(['a'])
  })
})

describe('flattenAgentRowLineage', () => {
  it('emits parent then descendants with increasing depth', () => {
    const rows = [row('a'), row('b', 'a'), row('c', 'b'), row('d')]
    const flat = flattenAgentRowLineage(rows)

    expect(flat.map((n) => [n.row.paneKey, n.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
      ['d', 0]
    ])
  })

  it('keeps a cyclic component visible even when other roots exist', () => {
    // 'root' is a normal root; a<->b form a disconnected cycle that has no root
    // entry and is unreachable from 'root' — it must still be surfaced.
    const rows = [row('root'), row('a', 'b'), row('b', 'a')]
    const flat = flattenAgentRowLineage(rows)
    expect(flat.map((n) => n.row.paneKey).sort()).toEqual(['a', 'b', 'root'])
  })
})
