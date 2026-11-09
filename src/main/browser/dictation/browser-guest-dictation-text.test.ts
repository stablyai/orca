import { describe, expect, it, vi } from 'vitest'
import { insertDictationTextIntoGuest } from './browser-guest-dictation-text'

function guestWithFocusedField(field: unknown) {
  const insertText = vi.fn(async (_text: string) => {})
  const frame = { executeJavaScript: vi.fn(async (_code: string) => field) }
  return {
    guest: { focusedFrame: frame, mainFrame: frame, isDestroyed: () => false, insertText },
    insertText
  }
}

describe('insertDictationTextIntoGuest', () => {
  it('types the text into the focused field, spaced from the words around the caret', async () => {
    const { guest, insertText } = guestWithFocusedField({ before: 'Hello', after: 'again' })

    await expect(insertDictationTextIntoGuest(guest, 'there')).resolves.toBe(true)

    expect(insertText).toHaveBeenCalledWith(' there ')
  })

  it('reports nothing landed when the page has no editable field focused', async () => {
    const { guest, insertText } = guestWithFocusedField(null)

    await expect(insertDictationTextIntoGuest(guest, 'there')).resolves.toBe(false)

    expect(insertText).not.toHaveBeenCalled()
  })
})
