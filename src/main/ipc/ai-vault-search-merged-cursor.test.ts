import { expect, it } from 'vitest'
import { decodeMergedSearchCursor } from './ai-vault-search-merged-cursor'

it('refuses a payload whose shape would change what a skip count means', () => {
  const refused = [
    { l: 20, s: 'newest', h: { local: { c: null, e: 3 } } },
    { l: 20, s: 'newest', h: { local: { c: null, e: -1, g: 7 } } },
    { l: 20, s: 'newest', h: { local: { c: null, e: 1.5, g: 7 } } },
    { l: 20, s: 'sideways', h: {} },
    { l: 0, s: 'newest', h: {} },
    { s: 'newest', h: {} },
    // A host cursor is an opaque string; a decoded object is a forged one.
    { l: 20, s: 'newest', h: { local: { c: { o: 1 }, e: 0, g: 7 } } }
  ]
  for (const payload of refused) {
    const raw = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    expect(decodeMergedSearchCursor(raw), JSON.stringify(payload)).toBeNull()
  }
})
