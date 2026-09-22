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
vi.mock('./AuthFailedBannerActions', async () => await import('./AuthFailedBannerActions.web'))

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
 * The page can honour none of the three: `forceReconnect` is inert there, `/pair-scan` is outside
 * its route root, and removal refuses. So the banner reports the state and names where the
 * controls are, rather than painting three that do nothing.
 */
describe('the auth-failed banner on the page', () => {
  it('renders no control at all, not a disabled one', () => {
    expect(
      render().root.findAll((node: ReactTestInstance) => String(node.type) === 'Pressable')
    ).toEqual([])
  })

  it('names the app instead', () => {
    expect(labels(render())).toContain('Reconnect or re-pair from the Orca app.')
  })

  it('keeps the sentence that says what happened', () => {
    expect(labels(render())).toContain(
      'Authentication failed — try reconnecting first; if it keeps failing, re-pair from desktop.'
    )
  })
})
