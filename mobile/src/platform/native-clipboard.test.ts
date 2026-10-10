/** The device half: what the shell actually does with a verb the host let through. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'

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
      // Named, not merely thrown: the mime is out of this verb's enum, so the parse is what
      // refuses it. A bare throw here would pass for a handler that reached the pasteboard and
      // failed there, which is the one outcome this case exists to rule out.
      await expect(serveNativeClipboardVerb(verb, params)).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ZodError && error.issues.some((issue) => issue.path[0] === 'mime')
      )
    }
    expect(clipboard.setStringAsync).not.toHaveBeenCalled()
    expect(clipboard.getStringAsync).not.toHaveBeenCalled()
  })
})
