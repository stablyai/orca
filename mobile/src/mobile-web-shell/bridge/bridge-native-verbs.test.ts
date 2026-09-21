/** The decision the seam makes before anything is dispatched, as a function of its inputs. */
import { describe, expect, it } from 'vitest'
import { BRIDGE_MEDIA_READ_MAX_BYTES } from './bridge-media-verbs'
import {
  BRIDGE_NATIVE_METHOD_PREFIX,
  BRIDGE_NATIVE_VERB_NAMES,
  BRIDGE_NATIVE_VERBS,
  isBridgeNativeMethod,
  readBridgeNativeVerbCall
} from './bridge-native-verbs'

const ALL = [...BRIDGE_NATIVE_VERB_NAMES]

describe('which methods the seam claims', () => {
  it('claims every name under the prefix, whether or not this build serves it', () => {
    // Claiming an unknown `native.` method is the point: it is refused here rather than forwarded,
    // so a desktop never sees it and its `forbidden` can never be mistaken for this refusal.
    expect(isBridgeNativeMethod('native.clipboard.read')).toBe(true)
    expect(isBridgeNativeMethod('native.dictation.start')).toBe(true)
    expect(isBridgeNativeMethod(BRIDGE_NATIVE_METHOD_PREFIX)).toBe(true)
  })

  it('claims nothing else, so every desktop method still forwards', () => {
    for (const method of ['worktree.list', 'status.get', 'nativeish.clipboard.read', '']) {
      expect(isBridgeNativeMethod(method), method).toBe(false)
    }
  })
})

describe('reading a native verb call', () => {
  it('answers the verb and its parsed params when everything lines up', () => {
    expect(
      readBridgeNativeVerbCall({
        method: 'native.clipboard.write',
        granted: ALL,
        params: { mime: 'text', value: 'copied' }
      })
    ).toEqual({
      ok: true,
      verb: 'native.clipboard.write',
      params: { mime: 'text', value: 'copied' }
    })
  })

  it('names a verb this build has no row for', () => {
    const read = readBridgeNativeVerbCall({
      method: 'native.dictation.start',
      granted: ALL,
      params: {}
    })
    expect(read.ok).toBe(false)
    expect(read.ok === false && read.refusal).toBe('unknown-verb')
  })

  it('names a verb the page was never granted', () => {
    // Unreachable through a real host while every page is offered every verb, and the whole point
    // of the check the moment a grant is per-route.
    const read = readBridgeNativeVerbCall({
      method: 'native.clipboard.read',
      granted: ['native.clipboard.write'],
      params: { mime: 'text' }
    })
    expect(read.ok).toBe(false)
    expect(read.ok === false && read.refusal).toBe('ungranted')
  })

  it('names params the verb does not take, before any handler sees them', () => {
    for (const params of [
      {},
      { mime: 'text' },
      { mime: 'audio', value: 'x' },
      null,
      // A key the shell does not know. Stripped rather than refused, a page believing it meant
      // something would have been served as if it had not sent it.
      { mime: 'text', value: 'x', unexpected: true }
    ]) {
      const read = readBridgeNativeVerbCall({
        method: 'native.clipboard.write',
        granted: ALL,
        params
      })
      expect(read.ok, JSON.stringify(params)).toBe(false)
      expect(read.ok === false && read.refusal).toBe('invalid-params')
    }
  })

  it('no longer takes an image on the clipboard verb, because a verb now serves one', () => {
    // The broad shape was there so a later build could serve an image without a contract change.
    // `native.media.pick { source: 'clipboard' }` is that build, and it stages the image rather
    // than inlining it, so the clipboard verb is a text verb and says so at the wire.
    const read = readBridgeNativeVerbCall({
      method: 'native.clipboard.read',
      granted: ALL,
      params: { mime: 'image' }
    })
    expect(read.ok).toBe(false)
    expect(read.ok === false && read.refusal).toBe('invalid-params')
  })
})

describe('the media verbs on the same seam', () => {
  it('serves all three, and each is a grant name of its own', () => {
    expect([...BRIDGE_NATIVE_VERB_NAMES]).toEqual([
      'native.clipboard.write',
      'native.clipboard.read',
      'native.media.pick',
      'native.media.read',
      'native.media.release',
      'native.audio.start',
      'native.audio.read',
      'native.audio.stop',
      'native.wakelock.set'
    ])
  })

  it('answers each verb with the params it parsed', () => {
    expect(
      readBridgeNativeVerbCall({
        method: 'native.media.pick',
        granted: ALL,
        params: { source: 'clipboard', multiple: false }
      })
    ).toEqual({
      ok: true,
      verb: 'native.media.pick',
      params: { source: 'clipboard', multiple: false }
    })
    expect(
      readBridgeNativeVerbCall({
        method: 'native.media.read',
        granted: ALL,
        params: { handle: 'media-1', offset: 0, length: 16 }
      }).ok
    ).toBe(true)
    expect(
      readBridgeNativeVerbCall({
        method: 'native.media.release',
        granted: ALL,
        params: { handle: 'media-1' }
      }).ok
    ).toBe(true)
  })

  it('refuses a chunk longer than the upload path sends, before a file is opened', () => {
    const read = readBridgeNativeVerbCall({
      method: 'native.media.read',
      granted: ALL,
      params: { handle: 'media-1', offset: 0, length: BRIDGE_MEDIA_READ_MAX_BYTES + 1 }
    })
    expect(read.ok).toBe(false)
    expect(read.ok === false && read.refusal).toBe('invalid-params')
  })

  it('refuses each media verb to a page granted only the clipboard', () => {
    for (const method of ['native.media.pick', 'native.media.read', 'native.media.release']) {
      const read = readBridgeNativeVerbCall({
        method,
        granted: ['native.clipboard.read'],
        params: { source: 'library', multiple: false }
      })
      expect(read.ok, method).toBe(false)
      expect(read.ok === false && read.refusal).toBe('ungranted')
    }
  })

  it('declares a result for every verb, so a handler cannot answer a shape the page will not read', () => {
    for (const verb of BRIDGE_NATIVE_VERB_NAMES) {
      expect(BRIDGE_NATIVE_VERBS[verb].result.safeParse(undefined).success, verb).toBe(false)
    }
    expect(BRIDGE_NATIVE_VERBS['native.media.pick'].result.safeParse({ items: [] }).success).toBe(
      true
    )
  })
})
