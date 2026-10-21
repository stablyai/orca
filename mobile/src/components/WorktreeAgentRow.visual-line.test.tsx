import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { WorktreeAgentRow } from './WorktreeAgentRow'

vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('./AgentStateDot', () => ({ AgentStateDot: () => null }))
vi.mock('./MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))

function agent(lastAssistantMessage: string | null): RuntimeWorktreeAgentRow {
  return {
    paneKey: 'tab:leaf',
    parentPaneKey: null,
    state: 'done',
    agentType: 'claude',
    prompt: 'Show usage by day',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 1_000,
    updatedAt: 1_000
  }
}

describe('WorktreeAgentRow visual lines', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function label(row: RuntimeWorktreeAgentRow): string {
    act(() => {
      renderer = create(
        createElement(WorktreeAgentRow, { agent: row, depth: 0, now: 2_000, unvisited: false })
      )
    })
    return String(renderer!.root.findAll((node) => String(node.type) === 'Text')[0]!.props.children)
  }

  it('shows the words around a visual line, never the line itself', () => {
    expect(label(agent('Here it is.\n::orca-visual{file="usage.html"}\nSunday dips.'))).toBe(
      'Here it is.\nSunday dips.'
    )
  })

  it('falls back to the prompt when the reply is only a visual', () => {
    expect(label(agent('::orca-visual{file="usage.html" title="Usage"}'))).toBe('Show usage by day')
  })
})
