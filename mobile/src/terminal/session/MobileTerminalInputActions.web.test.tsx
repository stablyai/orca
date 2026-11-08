// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type * as ReactNative from 'react-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'

vi.mock('react-native', () => vi.importActual<typeof ReactNative>('react-native-web'))
vi.mock('lucide-react-native', () => ({
  ImagePlus: () => null,
  Mic: () => <span data-icon="mic" />,
  Square: () => <span data-icon="stop" />
}))

const idle = { isStarting: false, isRecording: false, isProcessing: false }

describe('terminal dictation button', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  function renderWith(dictation: typeof idle) {
    act(() => {
      root.render(
        <MobileTerminalInputActions
          canSend
          dictation={dictation}
          dictationMode="toggle"
          isAttaching={false}
          buttonStyle={null}
          activeButtonStyle={null}
          disabledButtonStyle={null}
          onDictationToggle={() => {}}
          onDictationPressIn={() => {}}
          onDictationPressOut={() => {}}
          onDictationCancel={() => {}}
          onAttachImage={() => {}}
          onAttachFile={() => {}}
        />
      )
    })
    return container.querySelector('[aria-label$="voice dictation"]')
  }

  it('turns the mic into a stop square while recording', () => {
    const button = renderWith({ ...idle, isRecording: true })
    expect(button?.getAttribute('aria-label')).toBe('Stop voice dictation')
    expect(button?.querySelector('[data-icon="stop"]')).not.toBeNull()
    expect(button?.querySelector('[data-icon="mic"]')).toBeNull()
  })

  it('shows the mic when idle', () => {
    const button = renderWith(idle)
    expect(button?.getAttribute('aria-label')).toBe('Start voice dictation')
    expect(button?.querySelector('[data-icon="mic"]')).not.toBeNull()
  })
})
