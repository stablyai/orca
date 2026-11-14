import { describe, expect, it } from 'vitest'
import { hostReadIntent, noteAppForegrounded, wasAppForegroundedRecently } from './host-read-intent'
import { prForBranchIntentParams } from '../source-control/review/pr-for-branch-revalidation'

const later = () => false
const justNow = () => true

describe('hostReadIntent', () => {
  it('treats a revalidation of data this launch read as the screen’s timer', () => {
    expect(hostReadIntent({ live: false, previousFromStore: false }, { pr: 1 }, later)).toBe(
      'background'
    )
  })

  it('marks a revalidation right after the app came back as foreground', () => {
    expect(hostReadIntent({ live: false, previousFromStore: false }, { pr: 1 }, justNow)).toBe(
      'foreground'
    )
  })

  it.each([
    ['an action’s read', { live: true, previousFromStore: false }, { pr: 1 }, 'action'],
    ['the first read of a screen', { live: false, previousFromStore: false }, undefined, 'open'],
    ['a copy from an earlier launch', { live: false, previousFromStore: true }, { pr: 1 }, 'open']
  ] as const)('%s is never a timer or a foreground return', (_label, read, previous, intent) => {
    expect(hostReadIntent(read, previous, justNow)).toBe(intent)
    expect(hostReadIntent(read, previous, later)).toBe(intent)
  })

  it('reads on the screen’s timer while the clock is set back, and fresh only after a real return', () => {
    const timerRead = (now: number) =>
      prForBranchIntentParams({
        intent: hostReadIntent({ live: false, previousFromStore: false }, { pr: 1 }, () =>
          wasAppForegroundedRecently(now)
        )
      })
    noteAppForegrounded(100_000)
    expect(timerRead(40_000)).toEqual({ reason: 'swr', acceptRevalidationOnly: true })
    expect(timerRead(99_999)).toEqual({ reason: 'swr', acceptRevalidationOnly: true })
    noteAppForegrounded(40_000)
    expect(timerRead(44_999)).toEqual({ reason: 'active' })
    expect(timerRead(45_000)).toEqual({ reason: 'swr', acceptRevalidationOnly: true })
  })
})
