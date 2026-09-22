import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))

import { AuthFailedBanner } from './AuthFailedBanner'

function labels(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node: ReactTestInstance) => String(node.type) === 'Text')
    .map((node) => String(node.props.children))
}

function render(props: Parameters<typeof AuthFailedBanner>[0]): ReactTestRenderer {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    rendered.tree = create(createElement(AuthFailedBanner, props))
  })
  if (rendered.tree === null) {
    throw new Error('the banner did not render')
  }
  return rendered.tree
}

/** The native app owns the host list, so the banner's Remove is a control that does something. */
describe('the auth-failed banner in the app', () => {
  it('offers Remove beside Retry and Re-pair', () => {
    const tree = render({
      canRetry: true,
      onRetry: () => {},
      onRepair: () => {},
      onRemove: () => {}
    })
    expect(labels(tree)).toContain('Remove')
  })

  it('hands the press to the screen that opens the confirm', () => {
    const removes: number[] = []
    const tree = render({
      canRetry: false,
      onRetry: () => {},
      onRepair: () => {},
      onRemove: () => removes.push(1)
    })
    const remove = tree.root
      .findAll((node: ReactTestInstance) => String(node.type) === 'Pressable')
      .find((node) =>
        node
          .findAll((child: ReactTestInstance) => String(child.type) === 'Text')
          .some((child) => String(child.props.children) === 'Remove')
      )
    act(() => {
      remove?.props.onPress()
    })
    expect(removes).toEqual([1])
  })
})
