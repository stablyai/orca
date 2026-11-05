import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDisclosuresForTests } from '../worktree/agent-child-disclosure'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'
import { WorktreeAgentList } from './WorktreeAgentList'

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

function agent(
  paneKey: string,
  parentPaneKey: string | null,
  displayName: string
): RuntimeWorktreeAgentRow {
  return {
    paneKey,
    parentPaneKey,
    state: 'working',
    agentType: 'hermes',
    prompt: displayName,
    taskTitle: displayName,
    displayName,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 1_000,
    updatedAt: 2_000
  }
}

function flatStyle(style: unknown): Record<string, unknown> {
  const value = typeof style === 'function' ? style({ pressed: false }) : style
  const list = Array.isArray(value) ? value : [value]
  return Object.assign({}, ...list.filter(Boolean))
}

function sessionPress(row: Parameters<typeof findAllByHostType>[0]) {
  const press = findAllByHostType(row, 'Pressable').find((node) => !node.props.accessibilityLabel)
  if (!press) {
    throw new Error('session pressable missing')
  }
  return press
}

describe('cross-workspace session nesting', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('nests a mirrored worker under the coordinator and expands it without opening the chat', async () => {
    const coordinator = 'tab-coord:leaf-coord'
    const worker = 'tab-worker:leaf-worker'
    const onAgentPress = vi.fn()
    const onPressIn = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(WorktreeAgentList, {
          agents: [
            agent(coordinator, null, 'Main Coordinator'),
            agent(worker, coordinator, 'Crew session-list nesting fix')
          ],
          now: 2_000,
          unvisited: false,
          fullList: true,
          onAgentPress,
          onPressIn
        })
      )
    })
    const visible = () =>
      renderer!.root
        .findAll((node) => node.props.agent !== undefined && node.props.depth !== undefined)
        .map((node) => [node.props.agent.paneKey, node.props.depth])
    expect(visible()).toEqual([[coordinator, 0]])

    const row = renderer!.root.find((node) => node.props.agent?.paneKey === coordinator)
    const rowPress = sessionPress(row)
    const toggle = renderer!.root.find(
      (node) => node.props.accessibilityLabel === 'Show 1 child agent'
    )
    expect(toggle.props.accessibilityState).toEqual({ expanded: false })
    expect(flatStyle(toggle.props.style)).toMatchObject({ minWidth: 44, minHeight: 44 })
    expect(rowPress.findAll((node) => node === toggle)).toHaveLength(0)
    const glyph = toggle.find((node) => node.props.pointerEvents === 'none')
    expect(glyph.props.pointerEvents).toBe('none')
    expect(glyph.findAll((node) => String(node.type) === 'ChevronRight')).toHaveLength(1)

    const stopPropagation = vi.fn()
    await act(async () => toggle.props.onPressIn({ stopPropagation }))
    expect(stopPropagation).toHaveBeenCalledTimes(1)
    expect(onPressIn).toHaveBeenCalledTimes(1)
    expect(onAgentPress).not.toHaveBeenCalled()
    await act(async () => toggle.props.onPress({ stopPropagation: vi.fn() }))
    expect(onAgentPress).not.toHaveBeenCalled()
    expect(toggle.props.accessibilityState).toEqual({ expanded: true })
    expect(visible()).toEqual([
      [coordinator, 0],
      [worker, 1]
    ])

    await act(async () => rowPress.props.onPress({ stopPropagation: vi.fn() }))
    expect(onAgentPress).toHaveBeenCalledTimes(1)
    expect(onAgentPress).toHaveBeenCalledWith(coordinator)

    const workerRow = renderer!.root.find((node) => node.props.agent?.paneKey === worker)
    await act(async () => sessionPress(workerRow).props.onPress({ stopPropagation: vi.fn() }))
    expect(onAgentPress).toHaveBeenCalledWith(worker)
  })

  it('opens a nested subagent in that child, not only its parent pane', async () => {
    const onAgentPress = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(WorktreeAgentList, {
          agents: [
            {
              ...agent('agent-1', null, 'Parent'),
              subagentObservation: 'live',
              subagents: [{ id: 'child', state: 'working', startedAt: 1_000 }]
            }
          ],
          now: 2_000,
          unvisited: false,
          fullList: true,
          statusLive: true,
          onAgentPress
        })
      )
    })
    const toggle = renderer!.root.find(
      (node) => node.props.accessibilityLabel === 'Show 1 child agent'
    )
    await act(async () => toggle.props.onPress({ stopPropagation: vi.fn() }))
    const childRow = renderer!.root.find((node) => node.props.childRow?.id === 'child')
    await act(async () => sessionPress(childRow).props.onPress({ stopPropagation: vi.fn() }))
    expect(onAgentPress).toHaveBeenCalledWith('agent-1', 'child')
  })
})
