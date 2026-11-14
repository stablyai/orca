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
    taskTitle: null,
    displayName: null,
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
  it('keeps all rows visible when the parent links form a cycle', () => {
    const rows = [row('a', 'b'), row('b', 'a')]
    const { rootRows, childrenByParentPaneKey } = buildAgentRowLineageTree(rows)

    expect(rootRows.map((r) => r.paneKey).sort()).toEqual(['a', 'b'])
    expect(childrenByParentPaneKey.size).toBe(0)
  })
})

describe('flattenAgentRowLineage', () => {
  it('keeps a cyclic component visible even when other roots exist', () => {
    // The disconnected a↔b cycle has no root and must remain visible beside the ordinary tree.
    const rows = [row('root'), row('a', 'b'), row('b', 'a')]
    const flat = flattenAgentRowLineage(rows)
    expect(flat.map((n) => n.row.paneKey).sort()).toEqual(['a', 'b', 'root'])
  })
})
