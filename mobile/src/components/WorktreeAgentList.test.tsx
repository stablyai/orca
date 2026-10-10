import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
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
vi.mock('./WorktreeAgentRow', () => ({ WorktreeAgentRow: 'WorktreeAgentRow' }))

function agent(paneKey: string, parentPaneKey: string | null = null): RuntimeWorktreeAgentRow {
  return {
    paneKey,
    parentPaneKey,
    state: 'working',
    agentType: 'codex',
    prompt: `Prompt ${paneKey}`,
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 1_000,
    updatedAt: 1_000
  }
}

describe('WorktreeAgentList', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('inserts CLI and native children immediately under their parent at one extra depth', async () => {
    const cli = {
      ...agent('cli'),
      subagents: [
        { id: 'review', description: 'Review tests', state: 'working' as const, startedAt: 100 },
        {
          id: 'navigation',
          description: 'Check navigation',
          state: 'waiting' as const,
          startedAt: 200
        }
      ],
      subagentClockOffsetMs: 0
    }
    const native = {
      ...agent('native', 'cli'),
      children: [
        {
          id: 'native-child',
          kind: 'agent' as const,
          name: 'Native review',
          state: 'working' as const,
          membership: 'live' as const,
          firstObservedAt: 100,
          observedAt: 900,
          stoppable: false,
          invocation: { invocationId: 'spawn', generation: 1 }
        }
      ]
    }
    const onAgentPress = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(WorktreeAgentList, {
          agents: [cli, native],
          now: 2_000,
          unvisited: false,
          statusLive: true,
          hostClockOffsetMs: 0,
          onAgentPress
        })
      )
    })
    const rows = renderer!.root.findAllByType('WorktreeAgentRow')
    expect(
      rows.map((row) => [row.props.agent.paneKey, row.props.childRow?.id, row.props.depth])
    ).toEqual([
      ['cli', undefined, 0],
      ['cli', 'review', 1],
      ['cli', 'navigation', 1],
      ['native', undefined, 1],
      ['native', 'native-child', 2]
    ])
    expect(rows[1].props.onPress).toBe(onAgentPress)
    expect(rows[4].props.onPress).toBe(onAgentPress)
    expect(renderer!.root.findAllByType('Pressable')).toHaveLength(0)
  })

  it('counts only real root parents when children are hidden by the existing summary', async () => {
    const first = {
      ...agent('first'),
      subagents: [{ id: 'child', state: 'working' as const, startedAt: 100 }]
    }
    await act(async () => {
      renderer = create(
        createElement(WorktreeAgentList, {
          agents: [first, agent('second')],
          now: 2_000,
          unvisited: false,
          statusLive: true,
          hostClockOffsetMs: 0
        })
      )
    })
    const summary = renderer!.root.findByType('Pressable')
    expect(summary.props.accessibilityLabel).toBe('Expand 2 agents')
    expect(renderer!.root.findAllByType('WorktreeAgentRow')).toHaveLength(0)
    await act(async () => summary.props.onPress({ stopPropagation: vi.fn() }))
    expect(renderer!.root.findAllByType('WorktreeAgentRow')).toHaveLength(3)
  })

  it('collapses multiple agents to their status icons by default', async () => {
    const stopPropagation = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(WorktreeAgentList, {
          agents: [agent('agent-1'), agent('agent-2'), agent('agent-3')],
          now: 2_000,
          unvisited: false
        })
      )
    })

    const summary = renderer!.root.findByType('Pressable')
    expect(summary.props.accessibilityLabel).toBe('Expand 3 agents')
    expect(summary.props.accessibilityState).toEqual({ expanded: false })
    expect(renderer!.root.findAllByType('WorktreeAgentRow')).toHaveLength(0)

    await act(async () => summary.props.onPress({ stopPropagation }))

    expect(stopPropagation).toHaveBeenCalledTimes(1)
    expect(renderer!.root.findByType('Pressable').props.accessibilityLabel).toBe(
      'Collapse 3 agents'
    )
    expect(renderer!.root.findAllByType('WorktreeAgentRow')).toHaveLength(3)
  })

  it('keeps a single agent visible without a redundant disclosure control', async () => {
    await act(async () => {
      renderer = create(
        createElement(WorktreeAgentList, {
          agents: [agent('agent-1')],
          now: 2_000,
          unvisited: false
        })
      )
    })

    expect(renderer!.root.findAllByType('Pressable')).toHaveLength(0)
    expect(renderer!.root.findAllByType('WorktreeAgentRow')).toHaveLength(1)
  })

  it('summarizes lineage by root agents like desktop', async () => {
    await act(async () => {
      renderer = create(
        createElement(WorktreeAgentList, {
          agents: [agent('parent-1'), agent('child-1', 'parent-1'), agent('parent-2')],
          now: 2_000,
          unvisited: false
        })
      )
    })

    expect(renderer!.root.findByType('Pressable').props.accessibilityLabel).toBe('Expand 2 agents')
  })
})
