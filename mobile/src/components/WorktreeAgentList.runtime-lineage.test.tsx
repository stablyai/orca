import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { WorktreeAgentSummary } from './WorktreeAgentSummary'
import { WorktreeAgentList } from './WorktreeAgentList'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight'
}))
vi.mock('./AgentStateDot', () => ({ AgentStateDot: () => null }))
vi.mock('./MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))

it('renders production-built canonical assignments as nested rows and groups only roots', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
  const { publicLineageFixture, canonicalChatRow, LINEAGE_PARENT, LINEAGE_CHILD } =
    await import('../../../src/main/runtime/runtime-agent-lineage.test-fixture')
  const { flattenAgentRowLineage } = await import('../worktree/agent-row-lineage')
  const f = publicLineageFixture()
  let tree: ReactTestRenderer | undefined
  try {
    const agents = f.build().agents
    expect(flattenAgentRowLineage(agents).map((node) => [node.row.paneKey, node.depth])).toEqual([
      [canonicalChatRow(LINEAGE_PARENT), 0],
      [canonicalChatRow(LINEAGE_CHILD), 1]
    ])
    await act(async () => {
      tree = create(
        createElement(WorktreeAgentList, {
          agents,
          now: 1_800_000_000_000,
          unvisited: false,
          statusLive: true
        })
      )
    })
    expect(
      tree?.root
        .findAll((node) => node.props.agent !== undefined)
        .map((node) => [node.props.agent.paneKey, node.props.depth])
    ).toEqual([
      [canonicalChatRow(LINEAGE_PARENT), 0],
      [canonicalChatRow(LINEAGE_CHILD), 1]
    ])
    expect(tree?.root.findAllByType(WorktreeAgentSummary)).toHaveLength(0)
    expect(agents[1].taskTitle).toBe('Build the worker result')
    expect(JSON.stringify(tree?.toJSON())).toContain('Coordinate work')
    expect(JSON.stringify(tree?.toJSON())).toContain('Implement work')
    expect(JSON.stringify(tree?.toJSON())).not.toContain('2 agents')
    expect(JSON.stringify(tree?.toJSON())).not.toContain(f.privateHandle)
    expect(JSON.stringify(tree?.toJSON())).not.toContain(f.privatePane)
    const orphan = {
      ...agents[1],
      paneKey: 'missing-parent-worker',
      parentPaneKey: 'missing-parent'
    }
    await act(async () =>
      tree?.update(
        createElement(WorktreeAgentList, {
          agents: [...agents, orphan],
          now: 1_800_000_000_000,
          unvisited: false
        })
      )
    )
    expect(
      tree?.root
        .findByType(WorktreeAgentSummary)
        .props.agents.map((row: RuntimeWorktreeAgentRow) => row.paneKey)
    ).toEqual([canonicalChatRow(LINEAGE_PARENT), orphan.paneKey])
  } finally {
    await act(async () => tree?.unmount())
    f.db.close()
    clock.mockRestore()
  }
})
