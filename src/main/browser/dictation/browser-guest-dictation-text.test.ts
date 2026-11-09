import { describe, expect, it, vi } from 'vitest'
import { insertDictationTextIntoGuest } from './browser-guest-dictation-text'

function guestWithFocusedField(field: unknown) {
  const executeJavaScript = vi
    .fn<(code: string) => Promise<unknown>>()
    .mockResolvedValueOnce(field)
    .mockResolvedValueOnce(true)
  const frame = { executeJavaScript }
  return { guest: { focusedFrame: frame, mainFrame: frame }, executeJavaScript }
}

describe('insertDictationTextIntoGuest', () => {
  it('types the text into the focused field, spaced from the words around the caret', async () => {
    const { guest, executeJavaScript } = guestWithFocusedField({ before: 'Hello', after: 'again' })

    await expect(insertDictationTextIntoGuest(guest, 'there')).resolves.toBe(true)

    expect(executeJavaScript).toHaveBeenCalledTimes(2)
    expect(executeJavaScript.mock.calls[1][0]).toContain('" there "')
  })

  it('reports nothing landed when the page has no editable field focused', async () => {
    const { guest, executeJavaScript } = guestWithFocusedField(null)

    await expect(insertDictationTextIntoGuest(guest, 'there')).resolves.toBe(false)

    expect(executeJavaScript).toHaveBeenCalledTimes(1)
  })
})
