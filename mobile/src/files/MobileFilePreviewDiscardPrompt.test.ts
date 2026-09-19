import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

import { MobileFilePreviewDiscardPrompt } from './MobileFilePreviewDiscardPrompt'

/** The mocked react-native host tag, which `node.type` holds as a string the typings do not name. */
function isTag(type: unknown, tag: string): boolean {
  return type === tag
}

function render(onStay: () => void, onDiscard: () => void): ReactTestRenderer {
  let renderer: ReactTestRenderer | null = null
  act(() => {
    renderer = create(createElement(MobileFilePreviewDiscardPrompt, { onStay, onDiscard }))
  })
  if (!renderer) {
    throw new Error('the prompt did not render')
  }
  return renderer
}

function press(renderer: ReactTestRenderer, accessibilityLabel: string): void {
  const pressable = renderer.root
    .findAll((node) => isTag(node.type, 'Pressable'))
    .find((node) => node.props.accessibilityLabel === accessibilityLabel)
  if (!pressable) {
    throw new Error(`no control labelled ${accessibilityLabel}`)
  }
  act(() => pressable.props.onPress())
}

describe('the unsaved-draft prompt', () => {
  it('asks the question in the screen itself, where a no-op Alert asked nothing', () => {
    const renderer = render(vi.fn(), vi.fn())
    const text = renderer.root
      .findAll((node) => isTag(node.type, 'Text'))
      .map((node) => node.props.children)
    expect(text).toContain('Discard unsaved edits?')
    expect(text).toContain('Stay')
    expect(text).toContain('Discard')
  })

  it('answers to stay without leaving', () => {
    const onStay = vi.fn()
    const onDiscard = vi.fn()
    press(render(onStay, onDiscard), 'Keep editing')
    expect(onStay).toHaveBeenCalledTimes(1)
    expect(onDiscard).not.toHaveBeenCalled()
  })

  it('answers to discard without staying', () => {
    const onStay = vi.fn()
    const onDiscard = vi.fn()
    press(render(onStay, onDiscard), 'Discard unsaved edits and leave')
    expect(onDiscard).toHaveBeenCalledTimes(1)
    expect(onStay).not.toHaveBeenCalled()
  })
})
