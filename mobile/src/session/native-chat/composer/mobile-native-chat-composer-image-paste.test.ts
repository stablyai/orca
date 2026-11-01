import { describe, expect, it } from 'vitest'
import {
  mobileComposerImagePasteDecision,
  mobileComposerImagePastePromptText,
  spliceMobileComposerPasteText,
  type MobileComposerImagePasteSnapshot
} from './mobile-native-chat-composer-image-paste'

const empty: MobileComposerImagePasteSnapshot = {
  imageFileCount: 0,
  otherFileCount: 0,
  textPlain: '',
  textUriList: '',
  textHtml: ''
}

describe('mobileComposerImagePasteDecision', () => {
  it('keeps typed text, links, html, and non-image files in the field', () => {
    expect(mobileComposerImagePasteDecision({ ...empty, textPlain: 'hello' })).toBeNull()
    expect(mobileComposerImagePasteDecision({ ...empty, textPlain: '   ' })).toBeNull()
    expect(
      mobileComposerImagePasteDecision({ ...empty, textUriList: 'https://example.test' })
    ).toBeNull()
    expect(mobileComposerImagePasteDecision({ ...empty, textHtml: '<b>hi</b>' })).toBeNull()
    expect(mobileComposerImagePasteDecision({ ...empty, otherFileCount: 1 })).toBeNull()
  })

  it('treats an empty paste as a hidden image and image files as attachments', () => {
    expect(mobileComposerImagePasteDecision(empty)).toBe('native')
    expect(
      mobileComposerImagePasteDecision({ ...empty, imageFileCount: 2, textPlain: 'caption' })
    ).toBe('files')
  })
})

describe('mobileComposerImagePastePromptText', () => {
  it('drops filename labels and keeps a real caption', () => {
    expect(mobileComposerImagePastePromptText('shot.png', ['shot.png'])).toBe('')
    expect(mobileComposerImagePastePromptText('/tmp/shot.png', ['shot.png'])).toBe('')
    expect(mobileComposerImagePastePromptText('file:///tmp/shot.png', ['shot.png'])).toBe('')
    expect(mobileComposerImagePastePromptText('look at this', ['shot.png'])).toBe('look at this')
    expect(mobileComposerImagePastePromptText('', ['shot.png'])).toBe('')
  })
})

describe('spliceMobileComposerPasteText', () => {
  it('inserts the caption at the selection', () => {
    expect(spliceMobileComposerPasteText('ac', 'b', { start: 1, end: 1 })).toEqual({
      text: 'abc',
      caret: 2
    })
    expect(spliceMobileComposerPasteText('hello', 'X', { start: 1, end: 4 })).toEqual({
      text: 'hXo',
      caret: 2
    })
  })
})
