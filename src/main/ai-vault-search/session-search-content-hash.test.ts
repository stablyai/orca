import { expect, it } from 'vitest'
import {
  EMPTY_CONTENT_HASH,
  foldContentHash,
  isCollapsibleContentHash
} from './session-search-content-hash'
import { userMessages } from './session-search-index-test-fixture'

it('reaches the same digest whether the prefix arrives whole or in two appends', () => {
  const messages = userMessages('turn', 5)
  const whole = foldContentHash(EMPTY_CONTENT_HASH, messages)
  const resumed = foldContentHash(
    foldContentHash(EMPTY_CONTENT_HASH, messages.slice(0, 2)),
    messages.slice(2)
  )

  expect(resumed).toEqual(whole)
  expect(whole.count).toBe(5)
})

it('freezes once the prefix limit is reached so later appends cannot move it', () => {
  // Found rather than imported: the limit is the module's business, and a test
  // that reads it off the export cannot notice the fold ignoring it.
  const capped = foldContentHash(EMPTY_CONTENT_HASH, userMessages('turn', 64))
  expect(capped.count).toBeLessThan(64)
  expect(foldContentHash(capped, userMessages('later', 20))).toEqual(capped)
})

it('separates two conversations that share an opening prompt', () => {
  const shared = userMessages('same opening', 1)
  const first = foldContentHash(EMPTY_CONTENT_HASH, [
    ...shared,
    { role: 'user', text: 'left', timestamp: null }
  ])
  const second = foldContentHash(EMPTY_CONTENT_HASH, [
    ...shared,
    { role: 'user', text: 'right', timestamp: null }
  ])
  expect(first.hash).not.toBe(second.hash)
})

it('refuses to collapse on a prefix too short to mean anything', () => {
  const one = foldContentHash(EMPTY_CONTENT_HASH, userMessages('only turn', 1))
  expect(isCollapsibleContentHash(one.hash, one.count)).toBe(false)
  const two = foldContentHash(EMPTY_CONTENT_HASH, userMessages('two turns', 2))
  expect(isCollapsibleContentHash(two.hash, two.count)).toBe(true)
  expect(isCollapsibleContentHash(null, 9)).toBe(false)
})
