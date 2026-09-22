import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))
// The substitution the page bundler makes for itself, made here by name: this suite runs under the
// native resolution, so the sibling has to be named to be the one the banner renders.
vi.mock('./AuthFailedRemoveAction', async () => await import('./AuthFailedRemoveAction.web'))

import { AuthFailedBanner } from './AuthFailedBanner'

function render(): ReactTestRenderer {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    rendered.tree = create(
      createElement(AuthFailedBanner, {
        canRetry: true,
        onRetry: () => {},
        onRepair: () => {},
        onRemove: () => {}
      })
    )
  })
  if (rendered.tree === null) {
    throw new Error('the banner did not render')
  }
  return rendered.tree
}

function labels(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node: ReactTestInstance) => String(node.type) === 'Text')
    .map((node) => String(node.props.children))
}

/**
 * The page holds no host list and no credential, so a Remove there could only refuse. This is the
 * control half of that: the boundary throwing is not enough if the screen still offers the button.
 */
describe('the auth-failed banner on the page', () => {
  it('shows no Remove', () => {
    expect(labels(render())).not.toContain('Remove')
  })

  it('keeps Retry and Re-pair, which both still do something there', () => {
    const rendered = labels(render())
    expect(rendered).toContain('Retry')
    expect(rendered).toContain('Re-pair')
  })

  it('renders no control at all for it, not a disabled one', () => {
    const pressables = render().root.findAll(
      (node: ReactTestInstance) => String(node.type) === 'Pressable'
    )
    expect(pressables).toHaveLength(2)
  })
})
