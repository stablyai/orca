import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { WorkspaceSessionJumpList } from './WorkspaceSessionJumpList'

vi.mock('../components/AgentStateDot', () => ({ AgentStateDot: 'AgentStateDot' }))
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

function agent(paneKey: string, conversationName: string): RuntimeWorktreeAgentRow {
  return {
    paneKey,
    parentPaneKey: null,
    state: 'done',
    agentType: 'grok',
    prompt: conversationName,
    taskTitle: null,
    displayName: null,
    conversationName,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 1_000,
    updatedAt: 1_000
  }
}

describe('WorkspaceSessionJumpList', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('scrolls the sessions and opens the one that was pressed', async () => {
    const onJump = vi.fn()
    await act(async () => {
      renderer = create(
        createElement(WorkspaceSessionJumpList, {
          agents: [agent('pane-a', 'Alpha'), agent('pane-b', 'Beta')],
          now: 2_000,
          onJump
        })
      )
    })
    const list = renderer!.root.find((node) => String(node.type) === 'ScrollView')
    expect(list.props.style.maxHeight).toBe(240)
    const openBeta = renderer!.root.find(
      (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Open Beta'
    )
    act(() => openBeta.props.onPress())
    expect(onJump).toHaveBeenCalledWith('pane-b')
    expect(
      renderer!.root
        .findAll((node) => String(node.type) === 'AgentStateDot')
        .map((node) => node.props.state)
    ).toEqual(['done', 'done'])
    expect(
      renderer!.root
        .findAll((node) => String(node.type) === 'MobileAgentIcon')
        .map((node) => node.props)
    ).toEqual([
      { agentId: 'grok', size: 13 },
      { agentId: 'grok', size: 13 }
    ])
  })

  it('draws nothing when there is no session to open', async () => {
    await act(async () => {
      renderer = create(
        createElement(WorkspaceSessionJumpList, {
          agents: [],
          now: 2_000,
          onJump: vi.fn()
        })
      )
    })
    expect(renderer!.toJSON()).toBeNull()
  })
})
