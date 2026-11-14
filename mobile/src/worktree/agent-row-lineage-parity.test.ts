import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { flattenAgentRowLineage } from './agent-row-lineage'

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

describe('agent lineage traversal', () => {
  it('releases the ancestor path between duplicate roots and sibling branches', () => {
    const firstRoot = row('root', null)
    const secondRoot = row('root', null)
    const firstChild = row('child', 'root')
    const secondChild = row('child', 'root')
    const grandchild = row('grandchild', 'child')
    const rows = [firstRoot, firstChild, secondChild, grandchild, secondRoot]
    const actual = flattenAgentRowLineage(rows)
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
})
