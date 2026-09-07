import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatPermission } from './MobileNativeChatPermission'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({ ShieldQuestion: 'ShieldQuestion' }))

describe('MobileNativeChatPermission', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('accepts only one response when two presses land in the same render batch', async () => {
    let resolveResponse: (accepted: boolean) => void = () => {}
    const response = new Promise<boolean>((resolve) => (resolveResponse = resolve))
    const onRespond = vi.fn(() => response)
    await act(async () => {
      renderer = create(
        createElement(MobileNativeChatPermission, {
          permission: { title: 'Approve?', options: [{ label: 'Allow', send: '1' }] },
          onRespond
        })
      )
    })
    const button = renderer.root.findByType('Pressable')

    act(() => {
      button.props.onPress()
      button.props.onPress()
    })

    expect(onRespond).toHaveBeenCalledOnce()
    await act(async () => resolveResponse(true))
  })
})
