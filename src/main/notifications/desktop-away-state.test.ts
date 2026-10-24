import { expect, it } from 'vitest'
import { readDesktopAwayState } from './desktop-away-state'

it.each([
  [179, false],
  [180, true],
  [181, true]
])('checks the three-minute boundary at %s seconds', (idle, away) => {
  expect(
    readDesktopAwayState({ getSystemIdleState: () => 'active', getSystemIdleTime: () => idle })
  ).toBe(away)
})
it('allows immediate delivery when locked and fails open when presence cannot be read', () => {
  expect(
    readDesktopAwayState({ getSystemIdleState: () => 'locked', getSystemIdleTime: () => 0 })
  ).toBe(true)
  expect(
    readDesktopAwayState({
      getSystemIdleState: () => {
        throw new Error('unsupported')
      },
      getSystemIdleTime: () => 0
    })
  ).toBeUndefined()
})

it('treats a windowless sending host as away without changing the visible-window idle rule', () => {
  const active = { getSystemIdleState: () => 'active', getSystemIdleTime: () => 0 }
  expect(readDesktopAwayState(active, false)).toBe(true)
  expect(readDesktopAwayState(active, true)).toBe(false)
})
