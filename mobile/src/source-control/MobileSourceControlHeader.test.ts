import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileSourceControlHeader } from './MobileSourceControlHeader'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'ChevronLeft',
  ExternalLink: 'ExternalLink',
  RefreshCw: 'RefreshCw',
  X: 'X'
}))

vi.mock('./mobile-source-control-styles', () => ({ styles: new Proxy({}, { get: () => ({}) }) }))

/**
 * The dock closes and the route goes back, and only one of them is a Back control.
 *
 * Nothing else pins this: no golden names this component and no parity census covers
 * `src/source-control`. The Back census reads what a control is called, so a single control
 * serving both modes has to be named "Back" in a mode where it dismisses a dock — which satisfies
 * the rule by making the wording wrong.
 */
describe('the source-control header control', () => {
  let tree: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
  })

  function render(embedded: boolean, handlers: { onBack: () => void; onClose: () => void }) {
    let rendered: ReactTestRenderer | null = null
    act(() => {
      rendered = create(
        createElement(MobileSourceControlHeader, {
          embedded,
          worktreeLabel: 'wt',
          ioBusy: false,
          onRefresh: () => {},
          ...handlers
        })
      )
    })
    if (rendered === null) {
      throw new Error('the header did not render')
    }
    tree = rendered
    return rendered
  }

  const labelled = (rendered: ReactTestRenderer, label: string) =>
    rendered.root.findAll((node) => node.props.accessibilityLabel === label)

  it('goes back from the route, named as a Back and pressing onBack', () => {
    const calls: string[] = []
    const rendered = render(false, {
      onBack: () => calls.push('back'),
      onClose: () => calls.push('close')
    })
    const control = labelled(rendered, 'Back to session').at(0)
    expect(control?.props.accessibilityRole).toBe('button')
    act(() => control?.props.onPress())
    expect(calls).toEqual(['back'])
    expect(labelled(rendered, 'Close source control')).toHaveLength(0)
  })

  it('closes the dock when embedded, named as a Close and pressing onClose', () => {
    const calls: string[] = []
    const rendered = render(true, {
      onBack: () => calls.push('back'),
      onClose: () => calls.push('close')
    })
    const control = labelled(rendered, 'Close source control').at(0)
    expect(control?.props.accessibilityRole).toBe('button')
    act(() => control?.props.onPress())
    expect(calls).toEqual(['close'])
    expect(labelled(rendered, 'Back to session')).toHaveLength(0)
  })
})
