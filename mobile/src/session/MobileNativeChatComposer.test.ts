import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    Pressable: 'Pressable',
    ScrollView: ({ children, ...props }: { children?: unknown }) =>
      React.createElement('ScrollView', props, children),
    StyleSheet: {
      create: (styles: unknown) => styles,
      hairlineWidth: 1
    },
    Text: 'Text',
    TextInput: 'TextInput',
    View: 'View'
  }
})

vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ImagePlus: 'ImagePlus',
  Mic: 'Mic',
  Square: 'Square'
}))

function suppressRendererWarning(): () => void {
  const original = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
      return
    }
    original(...args)
  })
  return () => spy.mockRestore()
}

describe('MobileNativeChatComposer', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  async function render(
    onSend: (text: string) => Promise<boolean>,
    onChangeText: () => void,
    isAttaching = false
  ) {
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(MobileNativeChatComposer, {
            value: ' hello ',
            onChangeText,
            onSend,
            isAttaching
          })
        )
      })
    } finally {
      restore()
    }
  }

  function sendButton(): { props: { onPress: () => Promise<void> } } {
    if (!renderer) {
      throw new Error('Composer was not rendered')
    }
    return renderer.root.find(
      (node) => node.type === 'Pressable' && node.props.accessibilityLabel === 'Send message'
    ) as { props: { onPress: () => Promise<void> } }
  }

  it('reports an accepted send without owning route-scoped draft cleanup', async () => {
    const onChangeText = vi.fn()
    const onSend = vi.fn().mockResolvedValue(true)
    await render(onSend, onChangeText)

    await act(async () => sendButton().props.onPress())

    expect(onSend).toHaveBeenCalledWith('hello')
    expect(onChangeText).not.toHaveBeenCalled()
  })

  it('keeps the draft when the send is rejected', async () => {
    const onChangeText = vi.fn()
    const onSend = vi.fn().mockResolvedValue(false)
    await render(onSend, onChangeText)

    await act(async () => sendButton().props.onPress())

    expect(onSend).toHaveBeenCalledWith('hello')
    expect(onChangeText).not.toHaveBeenCalled()
  })

  it('disables send while an attachment path is still being injected', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    await render(onSend, vi.fn(), true)

    expect(sendButton().props).toMatchObject({ disabled: true })
    await act(async () => sendButton().props.onPress())
    expect(onSend).not.toHaveBeenCalled()
  })
})
