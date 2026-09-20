/** The decision the seam makes before anything is dispatched, as a function of its inputs. */
import { describe, expect, it } from 'vitest'
import {
  BRIDGE_NATIVE_METHOD_PREFIX,
  BRIDGE_NATIVE_VERB_NAMES,
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

  it('takes an image on the wire, because the shape is broad and the handler is not', () => {
    // The mime is valid here and refused by the handler: that is what lets a later build serve it
    // without a contract change.
    const read = readBridgeNativeVerbCall({
      method: 'native.clipboard.read',
      granted: ALL,
      params: { mime: 'image' }
    })
    expect(read.ok).toBe(true)
  })
})
