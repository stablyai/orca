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

  it.each([
    [100, '2m'],
    [0, '']
  ] as const)('collapses agents and shows child age %s as %s', async (startedAt, age) => {
    const stopPropagation = vi.fn()
    const onAgentPress = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(WorktreeAgentList, {
          agents: [
            {
              ...agent('agent-1'),
              subagentObservation: 'live',
              children: [
                {
                  id: 'child',
                  kind: 'agent',
                  name: 'Review tests',
                  state: 'working',
                  membership: 'live',
                  firstObservedAt: startedAt,
                  observedAt: 900,
                  stoppable: false,
                  invocation: { invocationId: 'spawn', generation: 1 }
                }
              ],
              subagents: [{ id: 'obsolete', state: 'working', startedAt: 1 }]
            },
            agent('agent-2'),
            agent('agent-3')
          ],
          now: 120_100,
          unvisited: false,
          statusLive: true,
          onAgentPress
        })
      )
    })

    const summary = renderer!.root.findByType('Pressable')
    expect(summary.props.accessibilityLabel).toBe('Expand 3 agents')
    expect(summary.props.accessibilityState).toEqual({ expanded: false })
    expect(renderer!.root.findAll((node) => node.props.agent !== undefined)).toHaveLength(0)

    await act(async () => summary.props.onPress({ stopPropagation }))

    expect(stopPropagation).toHaveBeenCalledTimes(1)
    expect(summary.props.accessibilityLabel).toBe('Collapse 3 agents')
    const rows = renderer!.root.findAll((node) => node.props.agent !== undefined)
    expect(rows).toHaveLength(4)
    expect(rows[1].props.depth).toBe(1)
    expect(rows[1].props.agent.paneKey).toBe('agent-1')
    expect(rows[1].props.childRow).toMatchObject({
      id: 'child',
      name: 'Review tests',
      displayState: 'working'
    })
    await act(async () => rows[1].findByType('Pressable').props.onPress({ stopPropagation }))
    expect(onAgentPress).toHaveBeenCalledWith('agent-1')
    expect(rows[0].findAllByType('Text').at(-1)?.props.children).toBe('1m')
    expect(rows[1].findAllByType('Text').at(-1)?.props.children).toBe(age)
  })

  it("shows every agent row with no summary under the desktop's Full list layout", async () => {
    const onAgentPress = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(WorktreeAgentList, {
          agents: [
            {
              ...agent('agent-1'),
              subagentObservation: 'live',
              subagents: [{ id: 'child', state: 'working', startedAt: 1_000 }]
            },
            agent('agent-2'),
            agent('agent-3')
          ],
          now: 2_000,
          unvisited: false,
          fullList: true,
          statusLive: true,
          onAgentPress
        })
      )
    })
    const rows = renderer!.root.findAll((node) => node.props.agent !== undefined)
    expect(rows).toHaveLength(4)
    expect(rows[1].props.childRow.id).toBe('child')
    const childPress = renderer!.root.findByType('Pressable')
    await act(async () => childPress.props.onPress({ stopPropagation: vi.fn() }))
    expect(onAgentPress).toHaveBeenCalledWith('agent-1')
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
    expect(renderer!.root.findAll((node) => node.props.agent !== undefined)).toHaveLength(1)
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
