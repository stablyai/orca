import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileNativeChatMicButton } from './MobileNativeChatMicButton'
import type { MobileDictationPhase } from './native-chat-dictation-toggle'

vi.mock('react-native', () => ({ Pressable: 'Pressable' }))
vi.mock('lucide-react-native', () => ({ Mic: 'Icon', Square: 'Icon' }))

let renderer: ReactTestRenderer | undefined

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
})

function renderButton(dictationPhase: MobileDictationPhase, dictationMode = 'toggle') {
  act(() => {
    renderer = create(
      createElement(MobileNativeChatMicButton, {
        dictationPhase,
        dictationMode,
        onMicPress: vi.fn(),
        disabled: false,
        buttonStyle: undefined,
        pressedStyle: undefined
      })
    )
  })
  const [button] = renderer?.root.findAll((node) => String(node.type) === 'Pressable') ?? []
  return { label: button?.props.accessibilityLabel, disabled: button?.props.disabled }
}

describe('MobileNativeChatMicButton', () => {
  it('keeps a failed stream salvage unpressable during its grace period in both modes', () => {
    for (const mode of ['toggle', 'hold']) {
      expect(renderButton('salvaging', mode)).toEqual({
        label: 'Finishing dictation',
        disabled: true
      })
    }
  })

  it('leaves the other phases pressable', () => {
    expect(renderButton('idle')).toEqual({ label: 'Dictate', disabled: false })
    expect(renderButton('recording')).toEqual({ label: 'Stop dictation', disabled: false })
    expect(renderButton('processing')).toEqual({ label: 'Dictate', disabled: false })
  })
})
