import { describe, expect, it } from 'vitest'
import { countUnjustifiedDisables } from './check-unjustified-lint-disable-ratchet.mjs'

describe('countUnjustifiedDisables', () => {
  it.each([
    ['// eslint-disable-next-line no-console -- logs the boot banner', 0],
    ['// oxlint-disable-next-line no-console', 1],
    ['/* eslint-disable no-console */ const marker = " -- unrelated"', 1],
    ['/* eslint-disable no-console -- justified */', 0]
  ])('%s -> %i', (source, expected) => {
    expect(countUnjustifiedDisables(source)).toBe(expected)
  })
})
