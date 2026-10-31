import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { NotificationDeliverySection } from './NotificationDeliverySection'
import { DEFAULT_NOTIFICATION_DELIVERY } from './notification-delivery-preferences'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }))
vi.mock('react-native', () => ({
  StyleSheet: { create: (value: unknown) => value },
  View: 'View',
  Text: 'Text'
}))
vi.mock('../components/MobileSwitch', () => ({ MobileSwitch: 'Switch' }))

it('shows only phone-specific controls while desktop owns category eligibility', () => {
  const onChange = vi.fn()
  let renderer!: ReturnType<typeof create>
  act(() => {
    renderer = create(
      createElement(NotificationDeliverySection, { value: DEFAULT_NOTIFICATION_DELIVERY, onChange })
    )
  })
  const switches = () => findAllByHostType(renderer.root, 'Switch')
  expect(switches().map((node) => node.props.accessibilityLabel)).toEqual([
    'Only when away from desktop',
    'Notification sound',
    'Suppress while focused'
  ])
  expect(JSON.stringify(renderer.toJSON())).toContain(
    'Alert types follow each paired desktop’s notification settings.'
  )
  act(() => switches()[0].props.onValueChange(false))
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ onlyWhenDesktopAway: false, sound: true, suppressWhileViewing: true })
  )
  act(() => renderer.unmount())
})
