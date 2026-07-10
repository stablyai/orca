import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_TEXT_INSERT_CHUNK_BYTES,
  insertTextThroughCdp,
  iterateBrowserTextInsertionChunks,
  splitBrowserTextInsertionChunks
} from './browser-text-insertion'

describe('browser text insertion chunking', () => {
  it('keeps small text as a single CDP insertion chunk', () => {
    expect(splitBrowserTextInsertionChunks('hello')).toEqual(['hello'])
  })

  it('splits by UTF-8 bytes without splitting surrogate pairs', () => {
    const chunks = splitBrowserTextInsertionChunks('ab😀cd', 4)

    expect(chunks).toEqual(['ab', '😀', 'cd'])
    expect(chunks.join('')).toBe('ab😀cd')
  })

  it('iterates insertion chunks lazily without prebuilding the full chunk array', () => {
    const chunks = iterateBrowserTextInsertionChunks('abcdefghij', 4)

    expect(chunks.next()).toEqual({ done: false, value: 'abcd' })
    expect(chunks.next()).toEqual({ done: false, value: 'efgh' })
    expect(chunks.next()).toEqual({ done: false, value: 'ij' })
    expect(chunks.next()).toEqual({ done: true, value: undefined })
  })

  it('keeps a single multibyte character intact when the byte cap is smaller', () => {
    const chunks = splitBrowserTextInsertionChunks('😀a', 1)

    expect(chunks).toEqual(['😀', 'a'])
    expect(chunks.join('')).toBe('😀a')
  })

  it('sends bounded CDP insertText chunks in order', async () => {
    const sender = vi.fn().mockResolvedValue({})
    const text = 'x'.repeat(BROWSER_TEXT_INSERT_CHUNK_BYTES + 3)

    await insertTextThroughCdp(sender, text, { yieldBetweenChunks: false })

    expect(sender).toHaveBeenCalledTimes(2)
    expect(sender).toHaveBeenNthCalledWith(1, 'Input.insertText', {
      text: 'x'.repeat(BROWSER_TEXT_INSERT_CHUNK_BYTES)
    })
    expect(sender).toHaveBeenNthCalledWith(2, 'Input.insertText', { text: 'xxx' })
  })

  it('does not scan the full payload before the first CDP insertion resolves', async () => {
    let releaseFirstChunk: (() => void) | undefined
    let callCount = 0
    const sender = vi.fn(() => {
      callCount += 1
      if (callCount === 1) {
        return new Promise<void>((resolve) => {
          releaseFirstChunk = resolve
        })
      }
      return Promise.resolve()
    })
    const codePointAt = vi.spyOn(String.prototype, 'codePointAt')
    const text = 'x'.repeat(128)

    const pending = insertTextThroughCdp(sender, text, {
      maxChunkBytes: 8,
      yieldBetweenChunks: false
    })
    await Promise.resolve()

    expect(sender).toHaveBeenCalledTimes(1)
    expect(sender).toHaveBeenCalledWith('Input.insertText', { text: 'x'.repeat(8) })
    expect(codePointAt.mock.calls.length).toBeLessThan(text.length)

    releaseFirstChunk?.()
    await pending
  })
})
