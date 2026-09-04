import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BACKGROUND_NOTIFICATIONS_HINT,
  BACKGROUND_NOTIFICATIONS_UNSUPPORTED,
  BackgroundNotificationsSection,
  type BackgroundNotificationsSectionProps
} from './BackgroundNotificationsSection'

vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  Switch: 'Switch',
  Text: 'Text',
  View: 'View'
}))

type SwitchNode = { props: { value: boolean; disabled?: boolean } }

describe('BackgroundNotificationsSection', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(overrides: Partial<BackgroundNotificationsSectionProps> = {}) {
    act(() => {
      renderer = create(
        createElement(BackgroundNotificationsSection, {
          supported: true,
          resolved: true,
          enabled: true,
          agentStates: ['needs-input', 'finished'],
          onToggleEnabled: () => {},
          onToggleAgentState: () => {},
          ...overrides
        })
      )
    })
    return renderer!
  }

  function textOf(tree: ReactTestRenderer): string[] {
    return tree.root
      .findAllByType('Text' as never)
      .map((node) => node.props.children)
      .filter((child): child is string => typeof child === 'string')
  }

  it('shows the switch, the disclosure, and both agent-state sub-switches', () => {
    const texts = textOf(render())

    expect(texts).toEqual([
      'Background notifications',
      BACKGROUND_NOTIFICATIONS_HINT,
      'Needs input',
      'Task finished'
    ])
  })

  it('states verbatim which parties see the alert text and the push token', () => {
    expect(BACKGROUND_NOTIFICATIONS_HINT).toBe(
      "Get alerts while Orca is closed. Alerts show the same text as on your desktop. That text, your phone's push token, and opaque host and device ids pass through Orca's push service and Apple or Google. Turning this off or unpairing deletes the token."
    )
  })

  it('replaces the whole section when no paired host advertises remote push', () => {
    const tree = render({ supported: false })

    expect(textOf(tree)).toEqual([BACKGROUND_NOTIFICATIONS_UNSUPPORTED])
    expect(tree.root.findAllByType('Switch' as never)).toHaveLength(0)
  })

  it('renders nothing while the paired hosts are still being probed', () => {
    expect(render({ supported: false, resolved: false }).toJSON()).toBeNull()
  })

  it('reflects a sub-switch the user turned off', () => {
    const switches = render({ agentStates: ['needs-input'] }).root.findAllByType(
      'Switch' as never
    ) as unknown as SwitchNode[]

    expect(switches.map((node) => node.props.value)).toEqual([true, true, false])
  })

  it('locks the sub-switches while background notifications are off', () => {
    const switches = render({ enabled: false }).root.findAllByType(
      'Switch' as never
    ) as unknown as SwitchNode[]

    expect(switches.map((node) => node.props.disabled)).toEqual([undefined, true, true])
  })
})
