import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { clearDisclosuresForTests } from '../worktree/agent-child-disclosure'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { colors } from '../theme/mobile-theme'
import { WorktreeAgentList } from './WorktreeAgentList'
import { findAllByHostType, findByHostType } from '../test-support/react-test-renderer-host-nodes'

// Disclosures persist in a module cache across list remounts; isolate each test.
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

    const summary = findByHostType(renderer!.root, 'Pressable')
    expect(summary.props.accessibilityLabel).toBe('Expand 3 agents')
    expect(summary.props.accessibilityState).toEqual({ expanded: false })
    expect(renderer!.root.findAll((node) => node.props.agent !== undefined)).toHaveLength(0)

    await act(async () => summary.props.onPress({ stopPropagation }))

    expect(stopPropagation).toHaveBeenCalledTimes(1)
    expect(summary.props.accessibilityLabel).toBe('Collapse 3 agents')
    expect(renderer!.root.findAll((node) => node.props.agent !== undefined)).toHaveLength(3)
    await pressByLabel(renderer!, 'Show 1 child agent')
    const rows = renderer!.root.findAll((node) => node.props.agent !== undefined)
    expect(rows).toHaveLength(4)
    expect(rows[1].props.depth).toBe(1)
    expect(rows[1].props.agent.paneKey).toBe('agent-1')
    expect(rows[1].props.childRow).toMatchObject({
      id: 'child',
      name: 'Review tests',
      displayState: 'working'
    })
    await act(async () => findByHostType(rows[1], 'Pressable').props.onPress({ stopPropagation }))
    expect(onAgentPress).toHaveBeenCalledWith('agent-1')
    expect(findAllByHostType(rows[0], 'Text').at(-1)?.props.children).toBe('1m')
    expect(findAllByHostType(rows[1], 'Text').at(-1)?.props.children).toBe(age)
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
    await pressByLabel(renderer!, 'Show 1 child agent')
    const rows = renderer!.root.findAll((node) => node.props.agent !== undefined)
    expect(rows).toHaveLength(4)
    expect(rows[1].props.childRow.id).toBe('child')
    const childPress = findByHostType(rows[1], 'Pressable')
    await act(async () => childPress.props.onPress({ stopPropagation: vi.fn() }))
    expect(onAgentPress).toHaveBeenCalledWith('agent-1')
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

    expect(findAllByHostType(renderer!.root, 'Pressable')).toHaveLength(0)
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

    expect(findByHostType(renderer!.root, 'Pressable').props.accessibilityLabel).toBe(
      'Expand 2 agents'
    )
  })

  it('folds two or more idle children behind one row once the parent is expanded', async () => {
    const now = 24 * 60 * 60_000
    const fresh = (paneKey: string, parent?: string) => ({
      ...agent(paneKey, parent),
      updatedAt: now
    })
    // Silent rows without a live PTY decay to idle.
    const idle = (paneKey: string) => agent(paneKey, 'parent')
    await act(async () => {
      renderer = create(
        createElement(WorktreeAgentList, {
          agents: [fresh('parent'), fresh('busy', 'parent'), idle('idle-1'), idle('idle-2')],
          now,
          unvisited: false
        })
      )
    })
    const paneKeys = () =>
      renderer!.root
        .findAll((node) => node.props.agent !== undefined && node.props.depth !== undefined)
        .map((node) => node.props.agent.paneKey)

    expect(paneKeys()).toEqual(['parent'])
    await pressByLabel(renderer!, 'Show 3 child agents')
    expect(paneKeys()).toEqual(['parent', 'busy'])
    await pressByLabel(renderer!, 'Show 2 idle child agents')
    expect(paneKeys()).toEqual(['parent', 'busy', 'idle-1', 'idle-2'])

    // Scrolling the workspace list remounts cards; the user's disclosures must survive.
    act(() => renderer?.unmount())
    await act(async () => {
      renderer = create(
        createElement(WorktreeAgentList, {
          agents: [fresh('parent'), fresh('busy', 'parent'), idle('idle-1'), idle('idle-2')],
          now,
          unvisited: false
        })
      )
    })
    expect(paneKeys()).toEqual(['parent', 'busy', 'idle-1', 'idle-2'])
  })
})
