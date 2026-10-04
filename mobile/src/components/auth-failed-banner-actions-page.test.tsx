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

/**
 * Re-pair works from the page: its push of `/pair-scan` is handed to the shell, which opens the
 * native scan screen. Retry and Remove do not (`forceReconnect` is null, removal refuses), so the
 * banner names the app for those two rather than painting controls that do nothing.
 */
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

  it('keeps the sentence that says what happened', () => {
    expect(labels(render().root)).toContain(
      'Authentication failed — try reconnecting first; if it keeps failing, re-pair from desktop.'
    )
  })
})
