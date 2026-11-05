import { describe, expect, it } from 'vitest'
import {
  createMobileComposerPasteImageDelivery,
  mobileComposerImagePasteDecision,
  mobileComposerImagePasteFileKind,
  mobileComposerImagePastePromptText,
  mobileComposerImagePasteTarget,
  mobileComposerPastedImageFromClipboardData,
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

describe('mobileComposerImagePasteFileKind', () => {
  it('keeps only the image types the host can name', () => {
    expect(mobileComposerImagePasteFileKind('image/png')).toBe('image')
    expect(mobileComposerImagePasteFileKind('image/jpeg')).toBe('image')
    expect(mobileComposerImagePasteFileKind('image/jpg')).toBe('image')
    expect(mobileComposerImagePasteFileKind('image/gif')).toBe('image')
    expect(mobileComposerImagePasteFileKind('image/webp')).toBe('image')
    expect(mobileComposerImagePasteFileKind('image/heic')).toBe('other')
    expect(mobileComposerImagePasteFileKind('image/svg+xml')).toBe('other')
    expect(mobileComposerImagePasteFileKind('')).toBe('other')
  })
})

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

describe('mobileComposerPastedImageFromClipboardData', () => {
  it('stores the payload and keeps the original data URL for preview', () => {
    expect(mobileComposerPastedImageFromClipboardData('data:image/jpeg;base64,aGVsbG8=')).toEqual({
      base64: 'aGVsbG8=',
      uri: 'data:image/jpeg;base64,aGVsbG8='
    })
    expect(mobileComposerPastedImageFromClipboardData('aGVsbG8=')).toEqual({
      base64: 'aGVsbG8=',
      uri: 'data:image/png;base64,aGVsbG8='
    })
  })
})

describe('mobileComposerImagePasteTarget', () => {
  it('keeps an edit session off the live chat paste handler', () => {
    const route = (): void => undefined
    const explicit = (): void => undefined
    expect(mobileComposerImagePasteTarget(undefined, route, true)).toBeUndefined()
    expect(mobileComposerImagePasteTarget(undefined, route, false)).toBe(route)
    expect(mobileComposerImagePasteTarget(explicit, route, true)).toBe(explicit)
  })
})

describe('selectMobileComposerPasteImages', () => {
  const image = (base64: string): MobileComposerPastedImage => ({ base64 })

  it('keeps one copy of each image inside a single paste', () => {
    const selected = selectMobileComposerPasteImages(
      [image('abc'), image('abc'), image('def')],
      new Set()
    )

    expect(selected.images).toEqual([image('abc'), image('def')])
  })

  it('keeps one image when a file paste and a clipboard read of the same bytes finish together', async () => {
    const gate = createMobileComposerPasteImageDelivery()
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
    await expect(gate.take([image('same')])).resolves.toEqual([image('same')])
  })

  it('still accepts the next paste after a failed read', async () => {
    const gate = createMobileComposerPasteImageDelivery()

    await expect(gate.take(Promise.reject(new Error('read failed')))).rejects.toThrow('read failed')
    await expect(gate.take([image('abc')])).resolves.toEqual([image('abc')])
  })

  it('reports a later rejection while an earlier read is still pending', async () => {
    const gate = createMobileComposerPasteImageDelivery()
    let resolveFirst: (images: readonly MobileComposerPastedImage[]) => void = () => undefined
    const first = new Promise<readonly MobileComposerPastedImage[]>((resolve) => {
      resolveFirst = resolve
    })
    const fromFirst = gate.take(first)
    const laterError = gate.take(Promise.reject(new Error('later failed'))).then(
      () => null,
      (error: Error) => error.message
    )

    await Promise.resolve()
    resolveFirst([image('abc')])

    await expect(fromFirst).resolves.toEqual([image('abc')])
    await expect(laterError).resolves.toBe('later failed')
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
