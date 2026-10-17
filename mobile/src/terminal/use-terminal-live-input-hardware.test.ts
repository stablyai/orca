import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalLiveInputCommitHarness } from './terminal-live-input-commit.test-support'
import type { TerminalLiveHardwareKeyEvent } from './terminal-live-hardware-key-mapping'

vi.mock('../platform/live-input-composing-range', () => ({
  reportedLiveInputComposing: (isComposing: boolean | undefined) => isComposing
}))

function hardwareKey(key: string): TerminalLiveHardwareKeyEvent {
  return {
    key,
    modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    repeat: false
  }
}

describe('terminal live hardware input', () => {
  afterEach(() => vi.useRealTimers())

  it.each([
    ['ArrowLeft', '\x1b[D'],
    ['Backspace', '\x7f'],
    ['Escape', '\x1b']
  ])('leaves %s to the IME until composition commits', async (key, bytes) => {
    const { handlers, sent, captures, unmount } = createTerminalLiveInputCommitHarness()
    try {
      handlers.handleLiveInputChange({ nativeEvent: { text: 'nihao', isComposing: true } })
      const generation = handlers.getLiveInputInteractionGeneration()
      handlers.handleLiveInputHardwareKey(hardwareKey(key))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      expect(sent).toEqual([])
      expect(captures.at(-1)).toBe('nihao')
      expect(handlers.getLiveInputInteractionGeneration()).toBe(generation)

      handlers.handleLiveInputChange({ nativeEvent: { text: '你好', isComposing: false } })
      await vi.waitFor(() => expect(sent.join('')).toBe('你好'))
      handlers.handleLiveInputHardwareKey(hardwareKey(key))
      await vi.waitFor(() => expect(sent.join('')).toBe(`你好${bytes}`))
    } finally {
      unmount()
    }
  })

  it('Given hardware ArrowLeft When the event arrives Then sends CSI left without field text', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputHardwareKey({
      key: 'ArrowLeft',
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      repeat: false
    })
    await vi.waitFor(() => expect(sent).toEqual(['\x1b[D']))
  })

  it('Given hardware ArrowLeft after field text When it arrives Then clears the mirror baseline first', async () => {
    const { handlers, sent, captures } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('ab')
    await vi.waitFor(() => expect(sent).toEqual(['ab']))

    handlers.handleLiveInputHardwareKey({
      key: 'ArrowLeft',
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      repeat: false
    })

    await vi.waitFor(() => {
      expect(captures.at(-1)).toBe('')
      expect(sent).toEqual(['ab', '\x1b[D'])
    })
  })

  it('Given hardware Ctrl+C When the event arrives Then sends interrupt byte', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputHardwareKey({
      key: 'c',
      modifiers: { ctrl: true, alt: false, shift: false, meta: false },
      repeat: false
    })
    await vi.waitFor(() => expect(sent).toEqual(['\x03']))
  })

  it('Given hardware Meta+C When the event arrives Then ignores system shortcut', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputHardwareKey({
      key: 'c',
      modifiers: { ctrl: false, alt: false, shift: false, meta: true },
      repeat: false
    })
    await Promise.resolve()
    expect(sent).toEqual([])
  })

  it('Given hardware Backspace with field text When the event arrives Then mirrors local edit without raw DEL', async () => {
    const { handlers, sent, captures } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('ab')
    await vi.waitFor(() => expect(sent).toEqual(['ab']))

    handlers.handleLiveInputHardwareKey({
      key: 'Backspace',
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      repeat: false
    })

    await vi.waitFor(() => {
      expect(captures.at(-1)).toBe('a')
      expect(sent).toEqual(['ab', '\x7f'])
    })
  })

  it('Given rapid hardware Backspace When events arrive Then serializes both mirror erases', async () => {
    const { handlers, sent, captures } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('ab')
    await vi.waitFor(() => expect(sent).toEqual(['ab']))

    const backspace = {
      key: 'Backspace',
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      repeat: true
    }
    handlers.handleLiveInputHardwareKey(backspace)
    handlers.handleLiveInputHardwareKey(backspace)

    await vi.waitFor(() => {
      expect(captures.at(-1)).toBe('')
      expect(sent.join('')).toBe('ab\x7f\x7f')
    })
  })

  it('Given hardware Backspace with empty field When the event arrives Then sends DEL', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputHardwareKey({
      key: 'Backspace',
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      repeat: false
    })
    await vi.waitFor(() => expect(sent).toEqual(['\x7f']))
  })

  it('Given hardware Delete with field text When the event arrives Then follows accessory no-op local edit', async () => {
    const { handlers, sent, captures } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('ab')
    await vi.waitFor(() => expect(sent).toEqual(['ab']))

    handlers.handleLiveInputHardwareKey({
      key: 'Delete',
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      repeat: false
    })

    await Promise.resolve()
    await Promise.resolve()
    // Accessory forward-delete keeps field text; no terminal bytes when field is non-empty.
    expect(captures.at(-1)).toBe('ab')
    expect(sent).toEqual(['ab'])
  })

  it('Given hardware Ctrl+Space When the event arrives Then ignores for IME switching', async () => {
    const { handlers, sent } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputHardwareKey({
      key: ' ',
      modifiers: { ctrl: true, alt: false, shift: false, meta: false },
      repeat: false
    })
    await Promise.resolve()
    expect(sent).toEqual([])
  })

  it('counts terminal controls immediately but leaves system-owned keys alone', () => {
    const { handlers } = createTerminalLiveInputCommitHarness()
    const generation = handlers.getLiveInputInteractionGeneration()
    handlers.handleLiveInputHardwareKey(hardwareKey('ArrowLeft'))
    expect(handlers.getLiveInputInteractionGeneration()).toBe(generation + 1)
    handlers.handleLiveInputHardwareKey(hardwareKey('Enter'))
    handlers.handleLiveInputHardwareKey({
      ...hardwareKey('c'),
      modifiers: { ctrl: false, alt: false, shift: false, meta: true }
    })
    expect(handlers.getLiveInputInteractionGeneration()).toBe(generation + 1)
  })

  it('applies a hardware erase before subsequent printable input changes the field', async () => {
    const { handlers, sent, captures } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('ab')
    await vi.waitFor(() => expect(sent.join('')).toBe('ab'))
    const generation = handlers.getLiveInputInteractionGeneration()

    handlers.handleLiveInputHardwareKey(hardwareKey('Backspace'))
    expect(handlers.getLiveInputInteractionGeneration()).toBe(generation + 1)
    handlers.handleLiveInputChange('ac')

    await vi.waitFor(() => {
      expect(captures.at(-1)).toBe('ac')
      expect(sent.join('')).toBe('ab\x7fc')
    })
  })

  it('orders a hardware erase before navigation and ends the editing baseline', async () => {
    const { handlers, sent, captures } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('ab')
    await vi.waitFor(() => expect(sent.join('')).toBe('ab'))

    handlers.handleLiveInputHardwareKey(hardwareKey('Backspace'))
    handlers.handleLiveInputHardwareKey(hardwareKey('ArrowLeft'))

    await vi.waitFor(() => {
      expect(captures.at(-1)).toBe('')
      expect(sent.join('')).toBe('ab\x7f\x1b[D')
    })
  })

  it('sends the next erase to the terminal once rapid repeats empty the local field', async () => {
    const { handlers, sent, captures } = createTerminalLiveInputCommitHarness()
    handlers.handleLiveInputChange('ab')
    await vi.waitFor(() => expect(sent.join('')).toBe('ab'))

    for (let index = 0; index < 3; index += 1) {
      handlers.handleLiveInputHardwareKey(hardwareKey('Backspace'))
    }

    await vi.waitFor(() => {
      expect(captures.at(-1)).toBe('')
      expect(sent.join('')).toBe('ab\x7f\x7f\x7f')
    })
  })

  it('ignores native events delivered after disconnect', async () => {
    const { getHandlers, sent, setConnected } = createTerminalLiveInputCommitHarness()
    setConnected(false)
    getHandlers().handleLiveInputHardwareKey(hardwareKey('ArrowLeft'))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(sent).toEqual([])
  })

  it('rejects a stale native callback after the active terminal changes', async () => {
    const { handlers, sent, setActiveHandle } = createTerminalLiveInputCommitHarness()
    setActiveHandle('terminal-b')
    handlers.handleLiveInputHardwareKey(hardwareKey('ArrowLeft'))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(sent).toEqual([])
  })
})
