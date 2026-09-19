/** The device half: what the shell actually does with a verb the host let through. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clipboard = vi.hoisted(() => ({
  setStringAsync: vi.fn(() => Promise.resolve(true)),
  getStringAsync: vi.fn(() => Promise.resolve(''))
}))

vi.mock('expo-clipboard', () => clipboard)

import { serveNativeClipboardVerb } from './native-clipboard'

beforeEach(() => {
  clipboard.setStringAsync.mockReset()
  clipboard.setStringAsync.mockImplementation(() => Promise.resolve(true))
  clipboard.getStringAsync.mockReset()
  clipboard.getStringAsync.mockImplementation(() => Promise.resolve('on the pasteboard'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('serving a clipboard verb', () => {
  it('writes text and answers whether the pasteboard took it', async () => {
    await expect(
      serveNativeClipboardVerb('native.clipboard.write', { mime: 'text', value: 'copied' })
    ).resolves.toEqual({ written: true })
    expect(clipboard.setStringAsync.mock.calls).toEqual([['copied']])
  })

  it('carries a pasteboard refusal through rather than reporting success', async () => {
    clipboard.setStringAsync.mockImplementation(() => Promise.resolve(false))
    await expect(
      serveNativeClipboardVerb('native.clipboard.write', { mime: 'text', value: 'copied' })
    ).resolves.toEqual({ written: false })
  })

  it('reads text off the pasteboard', async () => {
    await expect(
      serveNativeClipboardVerb('native.clipboard.read', { mime: 'text' })
    ).resolves.toEqual({ value: 'on the pasteboard' })
  })

  it('refuses an image as out of scope here, not as something the platform cannot do', async () => {
    // `expo-clipboard` implements getImageAsync and setImageAsync, so a reason blaming the platform
    // would send whoever adds this looking for a gap that is not there.
    for (const verb of ['native.clipboard.write', 'native.clipboard.read'] as const) {
      const params =
        verb === 'native.clipboard.write' ? { mime: 'image', value: 'x' } : { mime: 'image' }
      await expect(serveNativeClipboardVerb(verb, params)).rejects.toThrow(
        /is not served by this build/
      )
    }
    expect(clipboard.setStringAsync).not.toHaveBeenCalled()
    expect(clipboard.getStringAsync).not.toHaveBeenCalled()
  })
})
