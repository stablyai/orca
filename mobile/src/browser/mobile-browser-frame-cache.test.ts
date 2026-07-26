import { describe, expect, it } from 'vitest'
import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame
} from '../transport/browser-screencast-protocol'
import {
  createMobileBrowserFrameDataUri,
  MOBILE_BROWSER_FRAME_MAX_IMAGE_BYTES,
  MobileBrowserFrameCache
} from './mobile-browser-frame-cache'

function entry(uri: string) {
  return { uri, metadata: {} }
}

function frame(imageBytes: number): BrowserScreencastFrame {
  return {
    opcode: BrowserScreencastOpcode.Frame,
    seq: 1,
    format: 'jpeg',
    metadata: {},
    image: new Uint8Array(imageBytes)
  }
}

describe('MobileBrowserFrameCache', () => {
  it('preserves LRU behavior below the count and retained-character limits', () => {
    const cache = new MobileBrowserFrameCache(2, 100)
    cache.set('first', entry('frame-1'))
    cache.set('second', entry('frame-2'))

    expect(cache.get('first')).toEqual(entry('frame-1'))
    cache.set('third', entry('frame-3'))

    expect(cache.peek('second')).toBeNull()
    expect(cache.evidence().keysOldestFirst).toEqual(['first', 'third'])
  })

  it('accepts the exact aggregate budget and evicts oldest at one character over', () => {
    const cache = new MobileBrowserFrameCache(4, 20)
    expect(cache.set('a', entry('x'.repeat(9)))).toBe(true)
    expect(cache.set('b', entry('x'.repeat(9)))).toBe(true)
    expect(cache.evidence()).toMatchObject({ entryCount: 2, retainedCharacters: 20 })

    expect(cache.set('c', entry(''))).toBe(true)
    expect(cache.peek('a')).toBeNull()
    expect(cache.evidence()).toMatchObject({ entryCount: 2, retainedCharacters: 11 })
  })

  it('does not retain one entry larger than the full budget', () => {
    const cache = new MobileBrowserFrameCache(4, 10)

    expect(cache.set('key', entry('x'.repeat(8)))).toBe(false)
    expect(cache.evidence()).toEqual({
      entryCount: 0,
      retainedCharacters: 0,
      keysOldestFirst: []
    })
  })
})

describe('createMobileBrowserFrameDataUri', () => {
  it('accepts the exact image-byte limit and rejects one byte over before base64 expansion', () => {
    expect(MOBILE_BROWSER_FRAME_MAX_IMAGE_BYTES).toBe(8 * 1024 * 1024)
    expect(createMobileBrowserFrameDataUri(frame(4), 4)).toBe('data:image/jpeg;base64,AAAAAA==')
    expect(createMobileBrowserFrameDataUri(frame(5), 4)).toBeNull()
  })
})
