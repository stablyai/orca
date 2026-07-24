import { describe, expect, it, vi } from 'vitest'
import {
  MacOSNativeProviderLineBuffer,
  MacOSNativeProviderResponseTooLargeError,
  consumeNativeProviderLines
} from './macos-native-provider-transport'

describe('consumeNativeProviderLines', () => {
  it('preserves complete lines and returns the partial tail', () => {
    const handleLine = vi.fn()

    const remaining = consumeNativeProviderLines('one\ntwo\npartial', handleLine, 16)

    expect(handleLine.mock.calls.map(([line]) => line)).toEqual(['one', 'two'])
    expect(remaining).toBe('partial')
  })

  it('rejects a complete oversized response before dispatching it', () => {
    const handleLine = vi.fn()

    expect(() => consumeNativeProviderLines('12345\n', handleLine, 4)).toThrow(
      MacOSNativeProviderResponseTooLargeError
    )
    expect(handleLine).not.toHaveBeenCalled()
  })

  it('rejects a newline-free response once its retained tail crosses the limit', () => {
    expect(() => consumeNativeProviderLines('12345', vi.fn(), 4)).toThrow(
      'native macOS provider response exceeded'
    )
  })
})

describe('MacOSNativeProviderLineBuffer', () => {
  it('parses a response delivered in more than 100,000 one-character fragments', () => {
    const buffer = new MacOSNativeProviderLineBuffer()
    const handleLine = vi.fn()
    const line = JSON.stringify({ id: 1, ok: true, result: 'x'.repeat(100_000) })

    for (const character of line) {
      buffer.feed(character, handleLine)
    }
    buffer.feed('\n', handleLine)

    expect(handleLine).toHaveBeenCalledWith(line)
  })

  it('clears an oversized fragmented line and accepts a later response', () => {
    const buffer = new MacOSNativeProviderLineBuffer(4)
    const handleLine = vi.fn()
    buffer.feed('12', handleLine)
    expect(() => buffer.feed('345', handleLine)).toThrow(MacOSNativeProviderResponseTooLargeError)

    buffer.feed('ok\n', handleLine)

    expect(handleLine).toHaveBeenCalledWith('ok')
  })
})
