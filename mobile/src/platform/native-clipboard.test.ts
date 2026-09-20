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

  it('does not take an image at all, because the media verbs stage one instead', async () => {
    // The out-of-scope refusal this verb used to answer is retired: an image on the pasteboard is
    // `native.media.pick { source: 'clipboard' }`, so the mime never parses here and the handler
    // is never reached. The seam refuses it as params before dispatch; this is the same answer one
    // step further in, for a caller that reaches the handler directly.
    for (const verb of ['native.clipboard.write', 'native.clipboard.read'] as const) {
      const params =
        verb === 'native.clipboard.write' ? { mime: 'image', value: 'x' } : { mime: 'image' }
      await expect(serveNativeClipboardVerb(verb, params)).rejects.toThrow()
    }
    expect(clipboard.setStringAsync).not.toHaveBeenCalled()
    expect(clipboard.getStringAsync).not.toHaveBeenCalled()
  })
})
