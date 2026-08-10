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
