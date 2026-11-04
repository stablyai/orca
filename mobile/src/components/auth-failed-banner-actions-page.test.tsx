import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))
// Name web sibling explicitly: native test resolver otherwise misses page bundler’s substitution.
vi.mock('./AuthFailedBannerActions', async () => await import('./AuthFailedBannerActions.web'))

import { AuthFailedBanner } from './AuthFailedBanner'

type Presses = { retry: number; repair: number; remove: number }

function render(presses: Presses = { retry: 0, repair: 0, remove: 0 }): ReactTestRenderer {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    rendered.tree = create(
      createElement(AuthFailedBanner, {
        canRetry: true,
        onRetry: () => (presses.retry += 1),
        onRepair: () => (presses.repair += 1),
        onRemove: () => (presses.remove += 1)
      })
    )
  })
  if (rendered.tree === null) {
    throw new Error('the banner did not render')
  }
  return rendered.tree
}

function pressables(tree: ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findAll((node: ReactTestInstance) => String(node.type) === 'Pressable')
}

function labels(node: ReactTestInstance): string[] {
  return node
    .findAll((child: ReactTestInstance) => String(child.type) === 'Text')
    .map((child) => String(child.props.children))
}

// Page re-pair hands /pair-scan to shell; Retry (null reconnect)/Remove (refused) must point to app instead of offering dead controls.
describe('the auth-failed banner on the page', () => {
  it('offers Re-pair alone, and its press reaches the screen', () => {
    const presses: Presses = { retry: 0, repair: 0, remove: 0 }
    const tree = render(presses)
    const controls = pressables(tree)
    expect(controls.map((node) => labels(node)[0])).toEqual(['Re-pair'])
    act(() => {
      for (const node of controls) {
        node.props.onPress()
      }
    })
    expect(presses).toEqual({ retry: 0, repair: 1, remove: 0 })
  })

  it('names the app for reconnect and removal, not for re-pair', () => {
    expect(labels(render().root)).toContain('Reconnect or remove this host from the Orca app.')
  })
})
