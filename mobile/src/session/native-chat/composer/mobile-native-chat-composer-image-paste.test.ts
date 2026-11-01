import { describe, expect, it } from 'vitest'
import {
  MOBILE_COMPOSER_PASTE_IMAGE_DEDUPE_MS,
  createMobileComposerPasteImageDelivery,
  mobileComposerImagePasteDecision,
  mobileComposerImagePastePromptText,
  selectMobileComposerPasteImages,
  spliceMobileComposerPasteText,
  type MobileComposerImagePasteSnapshot,
  type MobileComposerPastedImage
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

describe('selectMobileComposerPasteImages', () => {
  const image = (base64: string): MobileComposerPastedImage => ({ base64 })

  it('keeps one copy when the file paste and the clipboard fallback carry the same bytes', () => {
    const files = selectMobileComposerPasteImages(
      [image('abc'), image('abc'), image('def')],
      new Map(),
      1_000
    )
    const clipboard = selectMobileComposerPasteImages([image('abc')], files.seenAt, 1_500)

    expect(files.images).toEqual([image('abc'), image('def')])
    expect(clipboard.images).toEqual([])
  })

  it('accepts the same bytes again after the paste window', () => {
    const first = selectMobileComposerPasteImages([image('abc')], new Map(), 1_000)
    const again = selectMobileComposerPasteImages(
      [image('abc')],
      first.seenAt,
      1_000 + MOBILE_COMPOSER_PASTE_IMAGE_DEDUPE_MS
    )

    expect(again.images).toEqual([image('abc')])
  })

  it('keeps one image when a file paste and a clipboard read of the same bytes finish together', async () => {
    const gate = createMobileComposerPasteImageDelivery(() => 5_000)
    let resolveFile: (images: readonly MobileComposerPastedImage[]) => void = () => undefined
    let resolveClipboard: (images: readonly MobileComposerPastedImage[]) => void = () => undefined
    const file = new Promise<readonly MobileComposerPastedImage[]>((resolve) => {
      resolveFile = resolve
    })
    const clipboard = new Promise<readonly MobileComposerPastedImage[]>((resolve) => {
      resolveClipboard = resolve
    })
    const fromFile = gate.take(file)
    const fromClipboard = gate.take(clipboard)
    resolveClipboard([image('same')])
    resolveFile([image('same')])

    await expect(fromFile).resolves.toEqual([image('same')])
    await expect(fromClipboard).resolves.toEqual([])
  })

  it('still accepts the next paste after a failed read', async () => {
    const gate = createMobileComposerPasteImageDelivery(() => 1_000)

    await expect(gate.take(Promise.reject(new Error('read failed')))).rejects.toThrow('read failed')
    await expect(gate.take([image('abc')])).resolves.toEqual([image('abc')])
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
