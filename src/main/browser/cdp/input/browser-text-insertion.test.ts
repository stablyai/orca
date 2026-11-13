import { describe, expect, it } from 'vitest'
import { splitBrowserTextInsertionChunks } from '../../../../shared/browser-text-insertion-chunks'

describe('browser text insertion chunking', () => {
  it('keeps a single multibyte character intact when the byte cap is smaller', () => {
    const chunks = splitBrowserTextInsertionChunks('😀a', 1)

    expect(chunks).toEqual(['😀', 'a'])
    expect(chunks.join('')).toBe('😀a')
  })
})
