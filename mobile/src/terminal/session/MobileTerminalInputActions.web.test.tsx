// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type * as ReactNative from 'react-native'
import { expect, it, vi } from 'vitest'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'

vi.mock('react-native', () => vi.importActual<typeof ReactNative>('react-native-web'))
vi.mock('lucide-react-native', () => ({
  ImagePlus: () => null,
  Mic: () => <i data-icon="mic" />,
  Square: () => <i data-icon="stop" />
}))

it('shows a stop square instead of the mic while recording', () => {
  const container = document.createElement('div')
  const noop = () => {}
  act(() =>
    createRoot(container).render(
      <MobileTerminalInputActions
        canSend
        dictation={{ isStarting: false, isRecording: true, isProcessing: false }}
        dictationMode="toggle"
        isAttaching={false}
        buttonStyle={null}
        activeButtonStyle={null}
        disabledButtonStyle={null}
        onDictationToggle={noop}
        onDictationPressIn={noop}
        onDictationPressOut={noop}
        onDictationCancel={noop}
        onAttachImage={noop}
        onAttachFile={noop}
      />
    )
  )
  expect(container.querySelector('[data-icon="stop"]')).not.toBeNull()
  expect(container.querySelector('[data-icon="mic"]')).toBeNull()
})
