import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import {
  MobileNativeChatForkContext,
  type MobileNativeChatForkOffer
} from '../use-mobile-native-chat-fork'
import { MobileNativeChatForkButton } from './MobileNativeChatForkButton'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('lucide-react-native', () => ({ GitBranch: 'GitBranch' }))

const message = { id: 'item-1', role: 'assistant' } as NativeChatMessage
let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function render(offer: MobileNativeChatForkOffer, fork = vi.fn()) {
  act(() => {
    renderer = create(
      createElement(
        MobileNativeChatForkContext.Provider,
        { value: { offerFor: () => offer, fork } },
        createElement(MobileNativeChatForkButton, { message })
      )
    )
  })
  return renderer!.root.findAllByType('Pressable' as never)
}

it('forks the response it sits beside on tap', () => {
  const fork = vi.fn()
  const [button] = render('available', fork)
  expect(button.props.accessibilityLabel).toBe('Fork from this response')
  act(() => button.props.onPress())
  expect(fork).toHaveBeenCalledWith(message)
})

it('draws disabled while a fork opens, and nothing on rows that cannot fork', () => {
  expect(render('disabled')[0].props.disabled).toBe(true)
  expect(render('hidden')).toHaveLength(0)
})
