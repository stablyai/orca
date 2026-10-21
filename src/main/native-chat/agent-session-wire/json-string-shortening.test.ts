import { expect, it } from 'vitest'
import { jsonBytes, shortenJsonStringsToFit } from './json-string-shortening'

it('returns the value itself when it already fits', () => {
  const value = { text: 'short' }
  expect(shortenJsonStringsToFit(value, 1_000)).toBe(value)
})

it('cuts long strings to fit and marks them, never splitting a surrogate pair', () => {
  const value = { text: '😀'.repeat(2_000), other: 'x'.repeat(4_000) }
  const fitted = shortenJsonStringsToFit(value, 2_000)
  expect(fitted).not.toBeNull()
  expect(jsonBytes(fitted)).toBeLessThanOrEqual(2_000)
  expect(fitted?.text.endsWith('…')).toBe(true)
  // A lone high surrogate would serialize as an escape and render as a broken glyph.
  expect(fitted?.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
})

it('leaves identifiers whole', () => {
  const id = 'i'.repeat(3_000)
  const fitted = shortenJsonStringsToFit({ id, itemId: id, text: 'x'.repeat(3_000) }, 7_000)
  expect(fitted).toMatchObject({ id, itemId: id })
})

it('is null when even the shortest cut cannot fit', () => {
  const many = Array.from({ length: 1_000 }, () => 'x'.repeat(200))
  expect(shortenJsonStringsToFit(many, 1_000)).toBeNull()
})
