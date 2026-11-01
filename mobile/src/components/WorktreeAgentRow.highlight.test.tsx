import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { colors, spacing } from '../theme/mobile-theme'
import { findByHostType } from '../test-support/react-test-renderer-host-nodes'
import { WorktreeAgentRow } from './WorktreeAgentRow'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('./AgentStateDot', () => ({ AgentStateDot: () => null }))
vi.mock('./MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))

function agent(): RuntimeWorktreeAgentRow {
  return {
    paneKey: 'tab:leaf',
    parentPaneKey: null,
    state: 'done',
    agentType: 'claude',
    prompt: 'Show usage by day',
    taskTitle: null,
    displayName: 'Main Coordinator',
    lastAssistantMessage: 'QA found a real gap.',
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 1_000,
    updatedAt: 1_000
  }
}

function merged(style: unknown): Record<string, unknown> {
  const list = Array.isArray(style) ? style : [style]
  return Object.assign(
    {},
    ...list
      .filter(Boolean)
      .map((item) => (typeof item === 'function' ? item({ pressed: false }) : item))
  )
}

describe('WorktreeAgentRow selected highlight', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(props: { selectable?: boolean; selected?: boolean; depth?: number }): void {
    act(() => {
      renderer?.unmount()
      renderer = create(
        createElement(WorktreeAgentRow, {
          agent: agent(),
          depth: props.depth ?? 0,
          now: 2_000,
          unvisited: false,
          selectable: props.selectable,
          selected: props.selected,
          onPress: () => undefined
        })
      )
    })
  }

  function pressable(pressed: boolean): Record<string, unknown> {
    const style = findByHostType(renderer!.root, 'Pressable').props.style({ pressed })
    return Object.assign({}, ...style.filter(Boolean))
  }

  it('insets the fill around the text on compact and Select sessions rows', () => {
    render({ selectable: true, selected: true, depth: 1 })
    const selected = pressable(false)
    const pressed = pressable(true)
    const content = merged(findByHostType(renderer!.root, 'View').props.style)

    expect(selected.backgroundColor).toBe(colors.bgPanel)
    expect(selected.paddingHorizontal).toBe(spacing.sm)
    expect(selected.paddingVertical).toBe(spacing.xs)
    expect(selected.marginHorizontal).toBe(-spacing.sm)
    expect(selected.marginVertical).toBe(-spacing.xs)
    expect(selected.borderRadius).toBe(6)
    expect(pressed.backgroundColor).toBe(colors.bgRaised)
    expect(pressed.paddingHorizontal).toBe(selected.paddingHorizontal)
    expect(pressed.marginHorizontal).toBe(selected.marginHorizontal)
    expect(pressed.borderRadius).toBe(selected.borderRadius)
    // Depth indent stays on the content. Highlight padding is cancelled by its margin.
    expect(content.paddingLeft).toBe(14)
    expect(content.paddingHorizontal).toBeUndefined()
    expect(Number(selected.marginHorizontal) + Number(selected.paddingHorizontal)).toBe(0)
    expect(Number(selected.marginVertical) + Number(selected.paddingVertical)).toBe(0)

    render({ selectable: false, selected: true, depth: 1 })
    const compact = pressable(false)
    const compactContent = merged(findByHostType(renderer!.root, 'View').props.style)
    expect(compact.backgroundColor).toBeUndefined()
    expect(compact.paddingHorizontal).toBeUndefined()
    expect(compact.marginHorizontal).toBeUndefined()
    expect(compactContent.paddingLeft).toBe(14)
  })

  it('leaves an idle Select sessions row unfilled', () => {
    render({ selectable: true, selected: false })
    const idle = pressable(false)
    expect(idle.backgroundColor).toBeUndefined()
    expect(idle.paddingHorizontal).toBeUndefined()
    expect(idle.borderRadius).toBeUndefined()
    expect(pressable(true).backgroundColor).toBe(colors.bgRaised)
    expect(pressable(true).borderRadius).toBe(6)
  })
})
