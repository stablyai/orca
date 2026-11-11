import { describe, expect, it } from 'vitest'
import { isBackgroundHostRead } from './host-read-intent'

const later = () => false
const justNow = () => true

describe('isBackgroundHostRead', () => {
  it('treats a revalidation of data this launch read as the screen’s timer', () => {
    expect(isBackgroundHostRead({ live: false, previousFromStore: false }, { pr: 1 }, later)).toBe(
      true
    )
  })

  it.each([
    ['an action’s read', { live: true, previousFromStore: false }, { pr: 1 }, later],
    ['the first read of a screen', { live: false, previousFromStore: false }, undefined, later],
    ['a copy from an earlier launch', { live: false, previousFromStore: true }, { pr: 1 }, later],
    [
      'a read right after the app came to the foreground',
      { live: false, previousFromStore: false },
      { pr: 1 },
      justNow
    ]
  ])('reads fresh for %s', (_label, read, previous, recentlyForegrounded) => {
    expect(isBackgroundHostRead(read, previous, recentlyForegrounded)).toBe(false)
  })
})
