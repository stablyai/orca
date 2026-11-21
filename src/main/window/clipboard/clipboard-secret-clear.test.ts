import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readText: vi.fn<() => Promise<string>>(),
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
    readText: async () => clipboard,
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
  it('leaves whatever the owner copied afterwards', async () => {
    vi.useFakeTimers()
    const { clearer, clear, set, read } = setup('orcawh_secret')
    clearer('orcawh_secret')
    set('something else')
    await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_CLEAR_MS)
    expect(clear).not.toHaveBeenCalled()
    expect(read()).toBe('something else')
  })

  it('clears a second secret at its own one-minute deadline', async () => {
    vi.useFakeTimers()
    const { clearer, set, read } = setup('first')
    clearer('first')
    await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_CLEAR_MS / 2)
    set('second')
    clearer('second')

    await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_CLEAR_MS - 1)
    expect(read()).toBe('second')
    await vi.advanceTimersByTimeAsync(1)
    expect(read()).toBe('')
  })
})

describe('clearSecretFromClipboard', () => {
  it('clears through the publisher that wrote the secret, so Wayland’s helper owner is replaced', async () => {
    vi.useFakeTimers()
    mocks.readText.mockResolvedValue('orcawh_secret')
    mocks.publish.mockResolvedValue(undefined)
    clearSecretFromClipboard('orcawh_secret')
    await vi.advanceTimersByTimeAsync(SECRET_CLIPBOARD_CLEAR_MS)
    expect(mocks.publish).toHaveBeenCalledWith('', 'ordinary')
  })
})
