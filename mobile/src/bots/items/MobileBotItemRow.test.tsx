import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'

vi.mock('react-native', async () => {
  const React = await import('react')
  const host =
    (name: string) =>
    ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement(name, props, children)
  return {
    Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
    Appearance: { getColorScheme: () => 'dark', addChangeListener: () => ({ remove() {} }) },
    useColorScheme: () => 'dark',
    Pressable: host('Pressable'),
    Text: host('Text'),
    View: host('View'),
    StyleSheet: {
      create: (styles: unknown) => styles,
      hairlineWidth: 1,
      flatten: (s: unknown) => s
    }
  }
})
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  Circle: 'Circle',
  CircleCheck: 'CircleCheck',
  X: 'X'
}))
vi.mock('../../platform/haptics/haptics', () => ({ triggerSelection: vi.fn() }))
vi.mock('./MobileBotItemStatusIcon', () => ({ MobileBotItemStatusIcon: 'StatusIcon' }))

import { makeTestBotItem } from '../../../../src/shared/bots/bot-item.test-fixture'
import { MobileBotItemRow } from './MobileBotItemRow'

it('starts the accessible label with the item number and title', () => {
  let renderer: ReactTestRenderer | undefined
  act(() => {
    renderer = create(
      createElement(MobileBotItemRow, {
        item: makeTestBotItem(35, { title: 'Show item numbers' }),
        stale: false,
        unseen: false,
        checked: null,
        now: 0,
        disabled: false,
        onPress: () => {},
        onLongPress: () => {}
      })
    )
  })
  const pressable: string = 'Pressable'
  expect(renderer!.root.find((node) => node.type === pressable).props.accessibilityLabel).toMatch(
    /^#35 Show item numbers, /
  )
})
