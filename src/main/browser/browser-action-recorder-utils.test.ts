import { describe, expect, it } from 'vitest'
import type {
  BrowserRecorderDomFingerprint,
  BrowserRecorderInputState
} from '../../shared/browser-recorder-automation'
import { diffFingerprints } from './browser-action-recorder-utils'

function makeFingerprint(
  overrides: Partial<BrowserRecorderDomFingerprint> = {}
): BrowserRecorderDomFingerprint {
  return {
    url: 'https://example.com/stok',
    title: 'Stok',
    textLength: 100,
    interactive: 5,
    inputsDetail: [] as BrowserRecorderInputState[],
    bodyText: 'Stok listesi\nKaydet butonu',
    ...overrides
  }
}

describe('diffFingerprints', () => {
  it('lifts the changed body-text region out of the full snapshots', () => {
    const before = makeFingerprint({ bodyText: 'Stok listesi\nKaydet butonu' })
    const after = makeFingerprint({ bodyText: 'Stok listesi\nGuncelle butonu' })
    const diff = diffFingerprints(before, after)
    expect(diff.textChange).toEqual({ before: 'Kaydet', after: 'Guncelle' })
    expect(diff.changed).toContain('text')
  })

  it('returns null textChange when snapshots are identical', () => {
    const fingerprint = makeFingerprint()
    expect(diffFingerprints(fingerprint, fingerprint).textChange).toBeNull()
  })

  it('returns null textChange when body text is absent on either side', () => {
    const before = makeFingerprint({ bodyText: undefined })
    const after = makeFingerprint({ bodyText: 'Yeni' })
    expect(diffFingerprints(before, after).textChange).toBeNull()
  })

  it('caps each side of the text snippet to the log budget', () => {
    const long = 'x'.repeat(1000)
    const before = makeFingerprint({ bodyText: `a${long}b` })
    const after = makeFingerprint({ bodyText: `a${long}c` })
    const diff = diffFingerprints(before, after)
    // Changed region is just "b"→"c"; but with a full different tail the
    // snippet caps at textChangeMaxLength (400) per side.
    expect(diff.textChange).not.toBeNull()
    expect(diff.textChange?.before.length).toBeLessThanOrEqual(401)
    expect(diff.textChange?.after.length).toBeLessThanOrEqual(401)
  })

  it('still reports the compact delta fields alongside the snippet', () => {
    const before = makeFingerprint({ bodyText: 'abc', textLength: 3 })
    const after = makeFingerprint({ bodyText: 'abcd', textLength: 4 })
    const diff = diffFingerprints(before, after)
    expect(diff.textLengthDelta).toBe(1)
    expect(diff.textChange).toEqual({ before: '', after: 'd' })
  })

  it('reports the text change kind once even when delta and snippet both fire', () => {
    const before = makeFingerprint({ bodyText: 'Stok listesi\nKaydet butonu', textLength: 30 })
    const after = makeFingerprint({ bodyText: 'Stok listesi\nGuncelle butonu', textLength: 33 })
    const diff = diffFingerprints(before, after)
    // Both the length delta and the snippet describe the same change.
    expect(diff.textLengthDelta).toBe(3)
    expect(diff.textChange).toEqual({ before: 'Kaydet', after: 'Guncelle' })
    expect(diff.changed.filter((kind) => kind === 'text')).toHaveLength(1)
  })

  it('diffs unnamed inputs by their unique key, not the shared label', () => {
    const before = makeFingerprint({
      inputsDetail: [
        { key: 'input[0]', label: 'text', value: 'birinci' },
        { key: 'input[1]', label: 'text', value: 'ikinci' }
      ]
    })
    const after = makeFingerprint({
      inputsDetail: [
        { key: 'input[0]', label: 'text', value: 'birinci' },
        { key: 'input[1]', label: 'text', value: 'guncellendi' }
      ]
    })
    const diff = diffFingerprints(before, after)
    expect(diff.inputChanges).toEqual([
      { key: 'input[1]', label: 'text', before: 'ikinci', after: 'guncellendi' }
    ])
  })
})
