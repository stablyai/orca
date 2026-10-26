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
    // Images use staged media handles; clipboard.read rejects their MIME before reaching the device.
    for (const verb of ['native.clipboard.write', 'native.clipboard.read'] as const) {
      const params =
        verb === 'native.clipboard.write' ? { mime: 'image', value: 'x' } : { mime: 'image' }
      // Require the params refusal code so a pasteboard error cannot satisfy this assertion.
      await expect(serveNativeClipboardVerb(verb, params)).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ZodError && error.issues.some((issue) => issue.path[0] === 'mime')
      )
    }
    expect(clipboard.setStringAsync).not.toHaveBeenCalled()
    expect(clipboard.getStringAsync).not.toHaveBeenCalled()
  })
})
