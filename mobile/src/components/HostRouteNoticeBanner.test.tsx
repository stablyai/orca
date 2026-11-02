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

// Announce inserted banner because list reader may be below it; failure interrupts, bounced-route context stays polite so urgency retains meaning.
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
    // Match host name to avoid ElementType cast for arbitrary RN strings; first match is banner root carrying tested props.
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
