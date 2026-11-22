import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import { toggleDisclosure } from '../agent-child-disclosure'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Bell: 'Bell',
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight'
}))
vi.mock('../../../agents/presentation/AgentStateDot', () => ({ AgentStateDot: () => null }))
vi.mock('../../../components/icons/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))

import { WorktreeAgentList } from './WorktreeAgentList'

const NOW = 1_700_000_000_000
const DAY_MS = 86_400_000

// An idle child is a working row whose status went stale with no live terminal, as the card decays it.
function agent(
  paneKey: string,
  parentPaneKey: string | null,
  status: 'working' | 'idle',
  unread = false
): RuntimeWorktreeAgentRow {
  return {
    paneKey,
    parentPaneKey,
    state: 'working',
    agentType: 'claude',
    prompt: '',
    taskTitle: null,
    displayName: null,
    conversationName: paneKey,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: status === 'idle' ? NOW - DAY_MS : NOW,
    updatedAt: status === 'idle' ? NOW - DAY_MS : NOW,
    activity: { listed: true, status, unread, clearable: false, sortAt: NOW, title: paneKey }
  }
}

describe('collapsed agent groups', () => {
  let renderer: ReactTestRenderer | null = null
  beforeEach(() => {
    // Rows read fresh against the list's clock, so pin it to their timestamps.
    vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  })
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  it('marks the collapsed idle group unread and keeps unrelated cyclic agents visible', () => {
    toggleDisclosure('parent:root')
    act(() => {
      renderer = create(
        createElement(WorktreeAgentList, {
          unvisited: false,
          fullList: true,
          agents: [
            agent('root', null, 'working'),
            agent('idle-a', 'root', 'idle', true),
            agent('idle-b', 'root', 'idle'),
            agent('loop-a', 'loop-b', 'working'),
            agent('loop-b', 'loop-a', 'working')
          ]
        })
      )
    })
    const idleGroup = renderer!.root.find(
      (node) =>
        String(node.type) === 'Pressable' &&
        String(node.props.accessibilityLabel).startsWith('Show 2 idle child agents')
    )
    expect(idleGroup.props.accessibilityLabel).toContain('Unread')
    expect(idleGroup.findAll((node) => String(node.type) === 'Bell')).toHaveLength(1)
    const labels = renderer!.root
      .findAll((node) => String(node.type) === 'Text')
      .map((node) => node.props.children)
    expect(labels).toEqual(expect.arrayContaining(['loop-a', 'loop-b']))
    toggleDisclosure('parent:root')
  })
})
