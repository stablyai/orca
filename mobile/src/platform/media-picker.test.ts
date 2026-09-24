/**
 * The native form of the media seam: the device's own pickers, reached exactly as before.
 *
 * This half has no behaviour to test beyond that, and that is the point of the file — the screen's
 * picking moved behind a seam and the phone must run the same two calls it ran before, with the
 * same argument. The picking itself is `mobile-image-source-picker.test.ts`'s, and the pasteboard
 * is the clipboard seam's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[] = []

vi.mock('../session/mobile-image-source-picker', () => ({
  pickMobileImage: (source: string) => {
    calls.push(`pickMobileImage ${source}`)
    return Promise.resolve({ base64: 'BBB=', uri: 'file:///cache/one.png' })
  },
  pickMobileImages: (source: string) => {
    calls.push(`pickMobileImages ${source}`)
    return (async function* () {
      yield { base64: 'CCC=' }
    })()
  }
}))

import { useMediaPicker } from './media-picker'

beforeEach(() => {
  calls.length = 0
})

describe('picking media on a phone', () => {
  it('opens the library picker the screen already opened, source and all', async () => {
    expect(await useMediaPicker().pickImage('library')).toEqual({
      base64: 'BBB=',
      uri: 'file:///cache/one.png'
    })
    expect(calls).toEqual(['pickMobileImage library'])
  })

  it('streams a multi-select from the Files picker', async () => {
    const taken: string[] = []
    for await (const image of useMediaPicker().pickImages('files')) {
      taken.push(image.base64)
    }
    expect(taken).toEqual(['CCC='])
    expect(calls).toEqual(['pickMobileImages files'])
  })

  it('answers one object across renders, so a caller may hold it in a dependency list', () => {
    expect(useMediaPicker()).toBe(useMediaPicker())
  })
})
