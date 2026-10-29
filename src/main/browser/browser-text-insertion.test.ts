import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_TEXT_INSERT_CHUNK_BYTES,
  splitBrowserTextInsertionChunks
} from '../../shared/browser-text-insertion-chunks'
import { insertTextThroughCdp } from './browser-text-insertion'

describe('browser text insertion chunking', () => {
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
})
