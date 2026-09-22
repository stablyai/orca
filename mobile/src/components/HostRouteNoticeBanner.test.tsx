import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    Pressable: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('Pressable', props, children),
    Text: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('Text', props, children),
    View: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles }
  }
})
vi.mock('lucide-react-native', () => ({ X: 'X' }))

import { HostRouteNoticeBanner } from './HostRouteNoticeBanner'

/**
 * The banner appears in a screen that is already on screen, so a reader who has moved past the top
 * of the list never arrives at it. A live region is the only thing that carries it to them.
 *
 * The urgency follows the tone rather than being assertive for everything: the two callers are an
 * action that did not happen, which interrupts, and a bounced route, which is context for a list
 * already being read. Interrupting for the second one would train people to ignore the first.
 */
describe('the host route notice banner announces itself', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function banner(tone?: 'notice' | 'failure') {
    act(() => {
      renderer = create(
        createElement(HostRouteNoticeBanner, {
          message: 'Nothing happened',
          tone,
          onDismiss: () => {}
        })
      )
    })
    if (renderer === null) {
      throw new Error('the banner did not render')
    }
    // Matched by name rather than through `findAllByType`: React's `ElementType` does not admit an
    // arbitrary React Native host name, so the typed form needs a cast and this does not. The first
    // is the banner's own root, which is the element the props under test are on.
    return renderer.root.findAll((node) => String(node.type) === 'View')[0]
  }

  it('interrupts for a failure, which is an action that did not happen', () => {
    const root = banner('failure')
    expect(root.props.accessibilityRole).toBe('alert')
    expect(root.props.accessibilityLiveRegion).toBe('assertive')
  })

  it('waits its turn for a notice, which is context rather than a refusal', () => {
    const root = banner('notice')
    expect(root.props.accessibilityLiveRegion).toBe('polite')
    // No alert role: nothing here failed, and an alert is what the tone above is for.
    expect(root.props.accessibilityRole).toBeUndefined()
  })

  it('treats the default tone as the notice one, which is what the route caller passes', () => {
    const root = banner(undefined)
    expect(root.props.accessibilityLiveRegion).toBe('polite')
    expect(root.props.accessibilityRole).toBeUndefined()
  })
})
