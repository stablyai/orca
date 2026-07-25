import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatComposer } from './MobileNativeChatComposer'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
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
  Square: 'Square',
  X: 'X'
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

  it('renders a removable thumbnail for each pending image attachment', async () => {
    const onRemoveAttachment = vi.fn()
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(MobileNativeChatComposer, {
            value: '',
            onChangeText: vi.fn(),
            onSend: vi.fn().mockResolvedValue(true),
            attachments: [
              { id: 'img-1', path: '/tmp/a.png', previewUri: 'file:///a.png' },
              { id: 'img-2', path: '/tmp/b.png', previewUri: 'file:///b.png' }
            ],
            onRemoveAttachment
          })
        )
      })
    } finally {
      restore()
    }
    const thumbs = renderer!.root.findAll((node) => node.type === 'Image') as Array<{
      props: { source: { uri: string } }
    }>
    expect(thumbs.map((t) => t.props.source.uri)).toEqual(['file:///a.png', 'file:///b.png'])

    const remove = renderer!.root.findAll(
      (node) => node.type === 'Pressable' && node.props.accessibilityLabel === 'Remove image'
    ) as Array<{ props: { onPress: () => void } }>
    remove[1].props.onPress()
    expect(onRemoveAttachment).toHaveBeenCalledWith('img-2')
  })

  it('enables send with an attached image even when the text is empty', async () => {
    const onSend = vi.fn().mockResolvedValue(true)
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(MobileNativeChatComposer, {
            value: '',
            onChangeText: vi.fn(),
            onSend,
            attachments: [{ id: 'img-1', path: '/tmp/a.png', previewUri: 'file:///a.png' }]
          })
        )
      })
    } finally {
      restore()
    }
    expect(sendButton().props).toMatchObject({ disabled: false })
    await act(async () => sendButton().props.onPress())
    expect(onSend).toHaveBeenCalledWith('')
  })

  it('moves the caret to the insert point after an autocomplete pick, then releases control', async () => {
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(MobileNativeChatComposer, {
            value: '/c',
            onChangeText: vi.fn(),
            onSend: vi.fn().mockResolvedValue(true)
          })
        )
      })
    } finally {
      restore()
    }
    const input = () =>
      renderer!.root.find((node) => node.type === 'TextInput') as {
        props: {
          selection?: { start: number; end: number }
          onSelectionChange: (e: { nativeEvent: { selection: { end: number } } }) => void
        }
      }
    // Uncontrolled selection until a suggestion is applied.
    expect(input().props.selection).toBeUndefined()
    // Place the caret at the end so the slash trigger is active and suggestions render.
    await act(async () =>
      input().props.onSelectionChange({ nativeEvent: { selection: { end: 2 } } })
    )
    const firstSuggestion = renderer!.root.findAll(
      (node) => node.type === 'Pressable' && !node.props.accessibilityLabel
    )[0] as { props: { onPress: () => void } }
    await act(async () => firstSuggestion.props.onPress())
    // `/clear ` is 7 chars — the caret jumps just past the inserted command + space.
    expect(input().props.selection).toEqual({ start: 7, end: 7 })
    // The next native selection event releases control so manual placement still works.
    await act(async () =>
      input().props.onSelectionChange({ nativeEvent: { selection: { end: 7 } } })
    )
    expect(input().props.selection).toBeUndefined()
  })

  it('wires the mic for hold vs toggle dictation like the terminal composer', async () => {
    const onMicPress = vi.fn()
    const onMicPressIn = vi.fn()
    const onMicPressOut = vi.fn()
    const mic = () =>
      renderer!.root.find(
        (node) => node.type === 'Pressable' && node.props.accessibilityLabel === 'Dictate'
      ) as { props: { onPress?: unknown; onPressIn?: unknown; onPressOut?: unknown } }

    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(MobileNativeChatComposer, {
            value: '',
            onChangeText: vi.fn(),
            onSend: vi.fn().mockResolvedValue(true),
            onMicPress,
            dictationMode: 'hold',
            onMicPressIn,
            onMicPressOut
          })
        )
      })
      // Hold mode is walkie-talkie: press-in/out drive dictation, tap is inert.
      expect(mic().props.onPress).toBeUndefined()
      expect(mic().props.onPressIn).toBe(onMicPressIn)
      expect(mic().props.onPressOut).toBe(onMicPressOut)

      await act(async () => {
        renderer!.update(
          createElement(MobileNativeChatComposer, {
            value: '',
            onChangeText: vi.fn(),
            onSend: vi.fn().mockResolvedValue(true),
            onMicPress,
            dictationMode: 'toggle',
            onMicPressIn,
            onMicPressOut
          })
        )
      })
      // Toggle mode: tap drives dictation, press-in/out inert.
      expect(mic().props.onPress).toBe(onMicPress)
      expect(mic().props.onPressIn).toBeUndefined()
      expect(mic().props.onPressOut).toBeUndefined()
    } finally {
      restore()
    }
  })
})
