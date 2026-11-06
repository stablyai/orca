import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import {
  MobileNativeChatForkContext,
  type MobileNativeChatForkOffer
} from '../use-mobile-native-chat-fork'
import { MobileNativeChatResponseActions } from './MobileNativeChatResponseActions'

const renders = vi.hoisted(() => ({ count: 0 }))
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('lucide-react-native', () => ({ GitFork: 'GitFork' }))
vi.mock('../../../components/MobileSourceCopyButton', () => ({
  MobileSourceCopyButton: 'CopyButton'
}))
vi.mock('../../../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => {
    renders.count++
    return (_key: string, fallback: string) => fallback
  }
}))

const message: NativeChatMessage = {
  id: 'item-1',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'ok' }],
  timestamp: null,
  source: 'transcript'
}
let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function render(offer: MobileNativeChatForkOffer, copyText = 'ok') {
  const state = { offer }
  const listeners = new Set<() => void>()
  const fork = vi.fn()
  act(() => {
    renderer = create(
      createElement(
        MobileNativeChatForkContext.Provider,
        {
          value: {
            subscribe: (listener) => {
              listeners.add(listener)
              return () => listeners.delete(listener)
            },
            offerFor: () => state.offer,
            fork
          }
        },
        createElement(MobileNativeChatResponseActions, { message, copyText })
      )
    )
  })
  const publish = (next: MobileNativeChatForkOffer) =>
    act(() => {
      state.offer = next
      listeners.forEach((listener) => listener())
    })
  const find = (type: string) => renderer!.root.findAll((node) => node.type === type)
  return { fork, publish, find }
}

it('forks the response from the button beside copy, even when it has no copy text', () => {
  const { fork, find } = render('available')
  expect(find('CopyButton')).toHaveLength(1)
  act(() => find('Pressable')[0].props.onPress())
  expect(fork).toHaveBeenCalledWith(message)

  const visualOnly = render('available', '')
  expect(visualOnly.find('CopyButton')).toHaveLength(0)
  expect(visualOnly.find('Pressable')[0].props.accessibilityLabel).toBe('Fork from this response')
})

it('holds the slot across turn and support changes, so the meta row never shifts', () => {
  const { publish, find } = render('reserved')
  const slots = () => find('View').length + find('Pressable').length
  expect(slots()).toBe(2)
  publish('disabled')
  expect(find('Pressable')[0].props.disabled).toBe(true)
  expect(slots()).toBe(2)
  publish('available')
  expect(slots()).toBe(2)
  expect(render('hidden').find('Pressable')).toHaveLength(0)
})

it('re-renders only when its own offer changes', () => {
  const { publish } = render('available')
  const settled = renders.count
  publish('available')
  publish('available')
  expect(renders.count).toBe(settled)
  publish('disabled')
  expect(renders.count).toBeGreaterThan(settled)
})
