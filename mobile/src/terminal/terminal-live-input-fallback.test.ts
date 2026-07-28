import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalLiveInputView } from '../../packages/expo-terminal-live-input/src/TerminalLiveInputView'

vi.mock('expo-modules-core', () => ({
  requireNativeViewManager: () => {
    throw new Error('native view unavailable')
  }
}))

vi.mock('react-native', () => ({
  TextInput: 'TextInput'
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

describe('terminal live input fallback', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('uses submit as the sole Enter path while forwarding other keys', async () => {
    const onKeyPress = vi.fn()
    const onTerminalEnter = vi.fn()
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(
          createElement(TerminalLiveInputView, {
            onKeyPress,
            onTerminalEnter
          })
        )
      })
    } finally {
      restore()
    }
    const input = renderer!.root.find((node) => node.type === 'TextInput') as {
      props: {
        onKeyPress: (event: { nativeEvent: { key: string } }) => void
        onSubmitEditing: () => void
      }
    }
    const printableEvent = { nativeEvent: { key: 'a' } }

    act(() => {
      input.props.onKeyPress(printableEvent)
      input.props.onKeyPress({ nativeEvent: { key: 'Enter' } })
      input.props.onSubmitEditing()
    })

    expect(onKeyPress).toHaveBeenCalledTimes(1)
    expect(onKeyPress).toHaveBeenCalledWith(printableEvent)
    expect(onTerminalEnter).toHaveBeenCalledTimes(1)
  })
})
