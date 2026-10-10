import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileTerminalInputActions } from './MobileTerminalInputActions'
import type { DictationStatus } from '../hooks/mobile-dictation-session-state'
import type { FailedStreamFinishPhase } from '../hooks/mobile-dictation-stream-salvage'

vi.mock('react-native', () => ({ Pressable: 'Pressable', ActivityIndicator: 'Spinner' }))
vi.mock('lucide-react-native', () => ({ ImagePlus: 'Icon', Mic: 'Icon' }))

let renderer: ReactTestRenderer | undefined

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

function renderMic(
  status: DictationStatus,
  dictationMode: 'hold' | 'toggle',
  failedStreamFinish: FailedStreamFinishPhase = 'none'
) {
  act(() => {
    renderer = create(
      createElement(MobileTerminalInputActions, {
        canSend: true,
        isAttaching: false,
        dictation: {
          status,
          failedStreamFinish,
          isStarting: status === 'starting',
          isRecording: status === 'recording',
          isProcessing: status === 'processing'
        },
        dictationMode,
        buttonStyle: undefined,
        activeButtonStyle: undefined,
        disabledButtonStyle: undefined,
        onAttachImage: vi.fn(),
        onAttachFile: vi.fn(),
        onDictationToggle: vi.fn(),
        onDictationPressIn: vi.fn(),
        onDictationPressOut: vi.fn(),
        onDictationCancel: vi.fn()
      })
    )
  })
  const [, mic] = renderer?.root.findAll((node) => String(node.type) === 'Pressable') ?? []
  return mic
}

describe('MobileTerminalInputActions mic', () => {
  it('keeps a failed stream salvage uncancellable during its grace period', () => {
    for (const mode of ['hold', 'toggle'] as const) {
      const mic = renderMic('processing', mode, 'grace')
      expect(mic?.props.accessibilityLabel).toBe('Finishing voice dictation')
      expect(mic?.props.disabled).toBe(true)
    }
  })

  it('lets a salvage be cancelled once its grace period is over', () => {
    const mic = renderMic('processing', 'toggle', 'cancellable')
    expect(mic?.props.accessibilityLabel).toBe('Cancel voice dictation')
    expect(mic?.props.disabled).toBe(false)
  })
})
