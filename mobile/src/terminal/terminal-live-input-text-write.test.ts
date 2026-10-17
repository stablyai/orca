import { describe, expect, it, vi } from 'vitest'
import { writeTerminalLiveInputText } from './terminal-live-input-text-write'

describe('native live input text write', () => {
  it('writes text before restoring the caret through the native command', () => {
    const calls: unknown[] = []
    const ref = {
      current: {
        setNativeProps: vi.fn((props: unknown) => calls.push(props)),
        setSelection: vi.fn((start: number, end: number) => calls.push([start, end]))
      }
    }

    writeTerminalLiveInputText(ref, 'abcef', { start: 3, end: 3 })

    expect(calls).toEqual([{ text: 'abcef' }, [3, 3]])
  })

  it('leaves selection alone for an ordinary text reset', () => {
    const ref = { current: { setNativeProps: vi.fn(), setSelection: vi.fn() } }

    writeTerminalLiveInputText(ref, '')

    expect(ref.current.setNativeProps).toHaveBeenCalledWith({ text: '' })
    expect(ref.current.setSelection).not.toHaveBeenCalled()
  })

  it('allows the input to have unmounted before a write', () => {
    expect(() =>
      writeTerminalLiveInputText({ current: null }, '', { start: 0, end: 0 })
    ).not.toThrow()
  })
})
