import { describe, expect, it } from 'vitest'
import { countUnjustifiedDisables } from './check-unjustified-lint-disable-ratchet.mjs'

describe('countUnjustifiedDisables', () => {
  it.each([
    ['// eslint-disable-next-line no-console -- logs the boot banner', 0],
    ['// oxlint-disable-next-line no-console', 1],
    ['/* eslint-disable no-console */ const marker = " -- unrelated"', 1],
    ['/* eslint-disable no-console -- justified */', 0],
    ['export const label = "eslint-disable-next-line"', 0],
    ['export const label = `oxlint-disable ${x}`', 0],
    ['const re = /eslint-disable-line/', 0],
    ['const a = 1 // eslint-disable-line no-console', 1],
    [
      '// eslint-disable-next-line a\nf()\n/* oxlint-disable b -- why */\n// eslint-disable-next-line c',
      2
    ]
  ])('%s -> %i', (source, expected) => {
    expect(countUnjustifiedDisables(source)).toBe(expected)
  })
})
