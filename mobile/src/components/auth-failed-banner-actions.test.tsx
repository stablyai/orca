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

type Presses = { retry: number; repair: number; remove: number }

function render(presses: Presses): ReactTestRenderer {
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

function labelOf(node: ReactTestInstance): string {
  const [text] = node.findAll((child: ReactTestInstance) => String(child.type) === 'Text')
  return String(text?.props.children)
}

/** The app owns the connection, the keychain and the host list, so all three do something here. */
describe('the auth-failed banner in the app', () => {
  it('routes each press to the action the screen gave it', () => {
    const presses: Presses = { retry: 0, repair: 0, remove: 0 }
    const tree = render(presses)
    const controls = pressables(tree)
    expect(controls.map(labelOf)).toEqual(['Retry', 'Re-pair', 'Remove'])
    for (const [label, action] of [
      ['Retry', 'retry'],
      ['Re-pair', 'repair'],
      ['Remove', 'remove']
    ] as const) {
      presses.retry = presses.repair = presses.remove = 0
      act(() => controls.find((node) => labelOf(node) === label)!.props.onPress())
      expect(presses).toEqual({ retry: 0, repair: 0, remove: 0, [action]: 1 })
    }
  })

  it('drops Retry alone when there is no host to retry against', () => {
    const rendered: { tree: ReactTestRenderer | null } = { tree: null }
    act(() => {
      rendered.tree = create(
        createElement(AuthFailedBanner, {
          canRetry: false,
          onRetry: () => {},
          onRepair: () => {},
          onRemove: () => {}
        })
      )
    })
    expect(rendered.tree === null ? [] : pressables(rendered.tree).map(labelOf)).toEqual([
      'Re-pair',
      'Remove'
    ])
  })
})
