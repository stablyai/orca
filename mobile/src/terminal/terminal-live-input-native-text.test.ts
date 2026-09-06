import { describe, expect, it, vi } from 'vitest'
import { setTerminalLiveInputNativeText } from './terminal-live-input-native-text'

describe('terminal live input native text', () => {
  it('Given a native input When text changes Then updates the native field', () => {
    const setNativeProps = vi.fn()

    setTerminalLiveInputNativeText({ setNativeProps }, 'edited')

    expect(setNativeProps).toHaveBeenCalledWith({ text: 'edited' })
  })

  it('Given a web input When text changes Then relies on controlled state', () => {
    expect(() => setTerminalLiveInputNativeText({}, 'edited')).not.toThrow()
  })
})
