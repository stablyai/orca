import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatComposerMic } from './MobileNativeChatComposerMic'
import { findAllByHostType } from '../../../test-support/react-test-renderer-host-nodes'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
}))

vi.mock('lucide-react-native', () => ({ Mic: 'Mic', Square: 'Square' }))

describe('MobileNativeChatComposerMic', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('shows the mic busy while a stopped dictation is transcribing', () => {
    act(() => {
      renderer = create(
        createElement(MobileNativeChatComposerMic, {
          onMicPress: vi.fn(),
          micProcessing: true,
          disabled: false
        })
      )
    })
    const mic = renderer!.root.find(
      (node) =>
        String(node.type) === 'Pressable' &&
        node.props.accessibilityLabel === 'Transcribing dictation'
    )
    expect(findAllByHostType(mic, 'ActivityIndicator')).toHaveLength(1)
    expect(findAllByHostType(mic, 'Mic')).toHaveLength(0)
  })
})
