import { expect, it } from 'vitest'
import { decodeMergedSearchCursor, encodeMergedSearchCursor } from './ai-vault-search-merged-cursor'

const cursor = {
  limit: 20,
  sort: 'newest',
  hosts: {
    local: { c: null, e: 3, g: 7 },
    'ssh:box': { c: 'opaque', e: 0, g: 2 }
  }
} as const

it('round-trips a merged cursor through base64url', () => {
  expect(decodeMergedSearchCursor(encodeMergedSearchCursor(cursor))).toEqual(cursor)
})

it('refuses anything that is not a cursor this module minted', () => {
  for (const raw of ['', 'not-base64url!!', Buffer.from('{]').toString('base64url')]) {
    expect(decodeMergedSearchCursor(raw)).toBeNull()
  }
})

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
