import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: <T,>(styles: T) => styles }
}))
vi.mock('lucide-react-native', () => ({ ImagePlus: 'ImagePlus', Mic: 'Mic' }))
import { MobileTerminalInputActions } from './MobileTerminalInputActions'

it('keeps the microphone able to stop a recording while the connection is down', async () => {
  const idle = { isStarting: false, isRecording: false, isProcessing: false }
  const props = {
    canSend: false,
    isAttaching: false,
    dictation: { ...idle, isRecording: true },
    dictationMode: 'toggle',
    buttonStyle: {},
    activeButtonStyle: {},
    disabledButtonStyle: {},
    onAttachImage: vi.fn(),
    onAttachFile: vi.fn(),
    onDictationToggle: vi.fn(),
    onDictationPressIn: vi.fn(),
    onDictationPressOut: vi.fn(),
    onDictationCancel: vi.fn()
  }
  let renderer!: ReturnType<typeof create>
  await act(async () => {
    renderer = create(createElement(MobileTerminalInputActions, props))
  })
  const mic = () =>
    renderer.root.find(
      (node) =>
        String(node.type) === 'Pressable' && node.props.accessibilityLabel !== 'Attach a photo'
    )
  expect(mic().props.disabled).toBe(false)
  await act(async () =>
    renderer.update(createElement(MobileTerminalInputActions, { ...props, dictation: idle }))
  )
  expect(mic().props.disabled).toBe(true)
  await act(async () => renderer.unmount())
})
