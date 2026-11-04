import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { MobileSourceControlHeader } from './MobileSourceControlHeader'

vi.mock('react-native', () => ({
  Animated: { View: 'View' },
  Pressable: 'Pressable',
  StyleSheet: { create: <Styles>(styles: Styles) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'ChevronLeft',
  ExternalLink: 'ExternalLink',
  MoreHorizontal: 'MoreHorizontal',
  RefreshCw: 'RefreshCw',
  X: 'X'
}))

// The real menu measures its anchor in a native Modal; list its items as plain pressables instead.
vi.mock('../components/nav-bar/PullDownMenu', async () => {
  const { createElement: h } = await import('react')
  return {
    PullDownMenu: ({
      visible,
      groups
    }: {
      visible: boolean
      groups: readonly (readonly ActionSheetAction[])[]
    }) =>
      visible
        ? h(
            'Menu',
            null,
            groups.flat().map((action) =>
              h('MenuItem', {
                key: action.id ?? action.label,
                accessibilityLabel: action.label,
                disabled: action.disabled,
                onPress: action.onPress
              })
            )
          )
        : null
  }
})

// Dock dismissal and route Back need distinct controls; the dock never pops a route.
describe('the source-control header control', () => {
  let tree: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => tree?.unmount())
    tree = null
  })

  function render(
    embedded: boolean,
    handlers: { onBack: () => void; onClose: () => void; onOpenPrWeb?: () => void },
    ioBusy = false,
    onRefresh: () => void = () => {}
  ) {
    let rendered: ReactTestRenderer | null = null
    act(() => {
      rendered = create(
        createElement(MobileSourceControlHeader, {
          embedded,
          worktreeLabel: 'wt',
          ioBusy,
          onRefresh,
          prNumber: 12,
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
    rendered.root.findAll(
      (node) => typeof node.type === 'string' && node.props.accessibilityLabel === label
    )

  function openMenu(rendered: ReactTestRenderer) {
    act(() => labelled(rendered, 'More source control actions').at(0)?.props.onPress())
  }

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

  it.each([false, true])('keeps navigation enabled during file I/O (embedded: %s)', (embedded) => {
    const onBack = vi.fn()
    const onClose = vi.fn()
    const rendered = render(embedded, { onBack, onClose }, true)
    const navigation = labelled(rendered, embedded ? 'Close source control' : 'Back to session').at(
      0
    )
    expect(navigation?.props.disabled).not.toBe(true)
    openMenu(rendered)
    expect(labelled(rendered, 'Refresh source control').at(0)?.props.disabled).toBe(true)
    act(() => navigation?.props.onPress())
    expect(embedded ? onClose : onBack).toHaveBeenCalledTimes(1)
    expect(embedded ? onBack : onClose).not.toHaveBeenCalled()
  })

  it('refreshes and opens the pull request on the web from the ⋯ menu', () => {
    const onRefresh = vi.fn()
    const onOpenPrWeb = vi.fn()
    const rendered = render(
      false,
      { onBack: () => {}, onClose: () => {}, onOpenPrWeb },
      false,
      onRefresh
    )
    expect(labelled(rendered, 'Refresh source control')).toHaveLength(0)
    openMenu(rendered)
    act(() => labelled(rendered, 'Refresh source control').at(0)?.props.onPress())
    act(() => labelled(rendered, 'Open pull request #12 on the web').at(0)?.props.onPress())
    expect(onRefresh).toHaveBeenCalledTimes(1)
    expect(onOpenPrWeb).toHaveBeenCalledTimes(1)
  })

  it('offers no web link when there is no pull request to open', () => {
    const rendered = render(false, { onBack: () => {}, onClose: () => {} })
    openMenu(rendered)
    expect(labelled(rendered, 'Refresh source control')).toHaveLength(1)
    expect(labelled(rendered, 'Open pull request #12 on the web')).toHaveLength(0)
  })
})
