import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { buildRunningAgentChildRowModels } from '../../../src/shared/running-agent-child-rows'
import { WorktreeAgentRow } from './WorktreeAgentRow'
import { Pressable } from 'react-native'
import { AgentStateDot } from './AgentStateDot'
import { MobileAgentIcon } from './MobileAgentIcon'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: <T,>(styles: T) => styles }
}))
vi.mock('./AgentStateDot', () => ({ AgentStateDot: 'AgentStateDot' }))
vi.mock('./MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))

const parent: RuntimeWorktreeAgentRow = {
  paneKey: 'tab:10000000-0000-4000-8000-000000000000',
  parentPaneKey: null,
  state: 'working',
  agentType: 'codex',
  prompt: 'Parent work',
  taskTitle: null,
  displayName: null,
  lastAssistantMessage: null,
  toolName: null,
  toolInput: null,
  interrupted: false,
  stateStartedAt: 100,
  updatedAt: 1_000
}
const [childRow] = buildRunningAgentChildRowModels(
  {
    subagents: [
      {
        id: 'child',
        description: 'Review tests',
        agentType: 'reviewer',
        state: 'working',
        startedAt: 100
      }
    ]
  },
  {
    parentEvidenceFresh: true,
    transportObservation: 'live',
    parentObservedAt: 1_000,
    hostClockOffsetMs: 0
  }
)

describe('phone child row rendering and taps', () => {
  it('uses the child text/dot, hides the parent icon, and selects the exact parent without bubbling', async () => {
    const onPress = vi.fn()
    const stopPropagation = vi.fn()
    let tree: ReturnType<typeof create> | undefined
    await act(async () => {
      tree = create(
        createElement(WorktreeAgentRow, {
          agent: parent,
          childRow,
          now: 120_100,
          elapsedNow: 120_100,
          depth: 1,
          unvisited: false,
          onPress
        })
      )
    })
    expect(tree!.root.findByType(AgentStateDot).props.state).toBe('working')
    expect(tree!.root.findAllByType(MobileAgentIcon)).toHaveLength(0)
    expect(JSON.stringify(tree!.toJSON())).toContain('Review tests')
    expect(JSON.stringify(tree!.toJSON())).toContain('2m')
    await act(async () => tree!.root.findByType(Pressable).props.onPress({ stopPropagation }))
    expect(onPress).toHaveBeenCalledWith(parent.paneKey)
    expect(stopPropagation).toHaveBeenCalledOnce()
    await act(async () =>
      tree!.update(
        createElement(WorktreeAgentRow, {
          agent: parent,
          childRow,
          now: 120_100,
          depth: 1,
          unvisited: false,
          onPress,
          isReadOnly: true
        })
      )
    )
    expect(tree!.root.findByType(Pressable).props.disabled).toBe(true)
    expect(JSON.stringify(tree!.toJSON())).not.toContain('2m')
    await act(async () => tree!.unmount())
  })
})
