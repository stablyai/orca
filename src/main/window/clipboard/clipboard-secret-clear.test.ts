import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readText: vi.fn<() => string>(),
  publish: vi.fn<(text: unknown, kind?: string) => Promise<void>>()
}))

vi.mock('electron', () => ({ clipboard: { readText: mocks.readText, clear: vi.fn() } }))
vi.mock('./clipboard-text-publisher', () => ({ publishClipboardText: mocks.publish }))

import {
  clearSecretFromClipboard,
  createSecretClipboardClearer,
  SECRET_CLIPBOARD_CLEAR_MS
} from './clipboard-secret-clear'

function setup(initial: string) {
  let clipboard = initial
  const clear = vi.fn(async () => {
    clipboard = ''
  })
  const clearer = createSecretClipboardClearer({
    readText: () => clipboard,
    clear,
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer)
  })
  return { clearer, clear, set: (text: string) => (clipboard = text), read: () => clipboard }
}

afterEach(() => {
  vi.useRealTimers()
  mocks.readText.mockReset()
  mocks.publish.mockReset()
})

describe('createSecretClipboardClearer', () => {
  it('clears the secret after a minute when the clipboard still holds it', () => {
    vi.useFakeTimers()
    const { clearer, clear, read } = setup('orcawh_secret')
    clearer('orcawh_secret')
    vi.advanceTimersByTime(SECRET_CLIPBOARD_CLEAR_MS - 1)
    expect(clear).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(read()).toBe('')
  })

  it('leaves whatever the owner copied afterwards', () => {
    vi.useFakeTimers()
    const { clearer, clear, set, read } = setup('orcawh_secret')
    clearer('orcawh_secret')
    set('something else')
    vi.advanceTimersByTime(SECRET_CLIPBOARD_CLEAR_MS)
    expect(clear).not.toHaveBeenCalled()
    expect(read()).toBe('something else')
  })

  it('times a second secret from its own copy', () => {
    vi.useFakeTimers()
    const { clearer, clear, set } = setup('first')
    clearer('first')
    vi.advanceTimersByTime(SECRET_CLIPBOARD_CLEAR_MS / 2)
    set('second')
    clearer('second')
    vi.advanceTimersByTime(SECRET_CLIPBOARD_CLEAR_MS / 2)
    expect(clear).not.toHaveBeenCalled()
    vi.advanceTimersByTime(SECRET_CLIPBOARD_CLEAR_MS / 2)
    expect(clear).toHaveBeenCalledTimes(1)
  })
})

describe('clearSecretFromClipboard', () => {
  it('clears through the publisher that wrote the secret, so Wayland’s helper owner is replaced', () => {
    vi.useFakeTimers()
    mocks.readText.mockReturnValue('orcawh_secret')
    mocks.publish.mockResolvedValue(undefined)
    clearSecretFromClipboard('orcawh_secret')
    vi.advanceTimersByTime(SECRET_CLIPBOARD_CLEAR_MS)
    expect(mocks.publish).toHaveBeenCalledWith('', 'ordinary')
  })
})
