import { describe, expect, it } from 'vitest'
import { hostReadIntent, isBackgroundHostRead, isForegroundHostRead } from './host-read-intent'

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

describe('hostReadIntent', () => {
  it('marks only a revalidation right after the app came back as foreground', () => {
    const revalidation = { live: false, previousFromStore: false }
    expect(hostReadIntent(revalidation, { pr: 1 }, justNow)).toBe('foreground')
    expect(isForegroundHostRead(revalidation, { pr: 1 }, justNow)).toBe(true)
    expect(hostReadIntent(revalidation, { pr: 1 }, later)).toBe('background')
  })

  it.each([
    ['an action’s read', { live: true, previousFromStore: false }, { pr: 1 }, 'action'],
    ['the first read of a screen', { live: false, previousFromStore: false }, undefined, 'open'],
    ['a copy from an earlier launch', { live: false, previousFromStore: true }, { pr: 1 }, 'open']
  ] as const)(
    '%s is not a foreground return even right after coming back',
    (_label, read, previous, intent) => {
      expect(hostReadIntent(read, previous, justNow)).toBe(intent)
      expect(isForegroundHostRead(read, previous, justNow)).toBe(false)
    }
  )
})
