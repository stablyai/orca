import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDisclosuresForTests } from '../worktree/agent-child-disclosure'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { colors } from '../theme/mobile-theme'
import { WorktreeAgentList } from './WorktreeAgentList'
import { findAllByHostType, findByHostType } from '../test-support/react-test-renderer-host-nodes'

beforeEach(clearDisclosuresForTests)

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

async function pressByLabel(renderer: ReactTestRenderer, label: string) {
  const toggle = findAllByHostType(renderer.root, 'Pressable').find(
    (node) => node.props.accessibilityLabel === label
  )
  await act(async () => toggle!.props.onPress({ stopPropagation: vi.fn() }))
}

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

describe('selectable sidebar sessions in the agent list', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('opens the session from a taller row when sessions are selectable', async () => {
    const onAgentPress = vi.fn()
    const onLongPress = vi.fn()
    const stopPropagation = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(WorktreeAgentList, {
          agents: [agent('agent-1'), agent('agent-2')],
          now: 2_000,
          unvisited: false,
          fullList: true,
          selectable: true,
          onAgentPress,
          onLongPress
        })
      )
    })
    const rows = renderer!.root.findAll((node) => node.props.agent !== undefined)
    expect(rows).toHaveLength(2)
    const session = findByHostType(rows[0], 'Pressable')
    expect(findByHostType(rows[0], 'View').props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ minHeight: 44 })])
    )
    await act(async () => session.props.onPress({ stopPropagation }))
    expect(stopPropagation).toHaveBeenCalledTimes(1)
    expect(onAgentPress).toHaveBeenCalledWith('agent-1')
    await act(async () => session.props.onLongPress({ stopPropagation }))
    expect(onLongPress).toHaveBeenCalledTimes(1)
    expect(onLongPress).toHaveBeenCalledWith('agent-1')
  })

  it('opens the workspace from a tap and names that session on long-press when sessions are not selectable', async () => {
    const onAgentPress = vi.fn()
    const onLongPress = vi.fn()
    const onWorkspacePress = vi.fn()
    const stopPropagation = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(WorktreeAgentList, {
          agents: [
            {
              ...agent('agent-1'),
              subagentObservation: 'live',
              subagents: [{ id: 'child', state: 'working', startedAt: 1_000 }]
            }
          ],
          now: 2_000,
          unvisited: false,
          fullList: true,
          statusLive: true,
          onAgentPress,
          onLongPress,
          onWorkspacePress
        })
      )
    })
    const parentRow = renderer!.root.findAll((node) => node.props.agent !== undefined)[0]
    const parent = findByHostType(parentRow, 'Pressable')
    await act(async () => parent.props.onPress({ stopPropagation }))
    expect(onWorkspacePress).toHaveBeenCalledTimes(1)
    expect(onAgentPress).not.toHaveBeenCalled()
    await act(async () => parent.props.onLongPress({ stopPropagation }))
    expect(onLongPress).toHaveBeenCalledWith('agent-1')
    await pressByLabel(renderer!, 'Show 1 child agent')
    const child = findByHostType(
      renderer!.root.findAll((node) => node.props.childRow !== undefined)[0],
      'Pressable'
    )
    await act(async () => child.props.onPress({ stopPropagation }))
    expect(onAgentPress).toHaveBeenCalledWith('agent-1')
    await act(async () => child.props.onLongPress({ stopPropagation }))
    expect(onLongPress).toHaveBeenLastCalledWith('agent-1')
  })

  it('fills only the tapped session, including while the finger is down', async () => {
    await act(async () => {
      renderer = create(
        createElement(WorktreeAgentList, {
          agents: [
            {
              ...agent('agent-1'),
              subagentObservation: 'live',
              subagents: [{ id: 'child', state: 'working', startedAt: 1_000 }]
            },
            agent('agent-2')
          ],
          now: 2_000,
          unvisited: false,
          fullList: true,
          selectable: true,
          statusLive: true,
          selectedPaneKey: 'agent-1',
          onAgentPress: vi.fn()
        })
      )
    })
    await pressByLabel(renderer!, 'Show 1 child agent')
    const rows = renderer!.root.findAll((node) => node.props.agent !== undefined)
    const fill = (row: (typeof rows)[number], pressed: boolean) => {
      const style = findByHostType(row, 'Pressable').props.style({ pressed })
      return Object.assign({}, ...style.filter(Boolean))
    }
    expect(rows[0].props.selected).toBe(true)
    expect(rows[1].props.childRow.id).toBe('child')
    expect(rows[1].props.selected).toBeUndefined()
    expect(rows[2].props.selected).toBe(false)
    expect(fill(rows[0], false).backgroundColor).toBe(colors.bgPanel)
    expect(fill(rows[0], true).backgroundColor).toBe(colors.bgRaised)
    expect(fill(rows[1], false).backgroundColor).toBeUndefined()
    expect(fill(rows[2], true).backgroundColor).toBe(colors.bgRaised)
    expect(fill(rows[2], false).backgroundColor).toBeUndefined()
  })
})
