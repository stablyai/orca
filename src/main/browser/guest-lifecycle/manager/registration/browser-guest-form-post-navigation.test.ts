import { expect, it } from 'vitest'
import { createFormPostNavigationTracker } from './browser-guest-form-post-navigation'

function trackerWithPostResult(): ReturnType<typeof createFormPostNavigationTracker> {
  const tracker = createFormPostNavigationTracker()
  tracker.submitted('https://example.test/p')
  tracker.started('https://example.test/p')
  tracker.committed('https://example.test/p', null)
  return tracker
}

it('forgets a redirect target when the remembered address was reached by a fresh link', () => {
  const tracker = trackerWithPostResult()
  tracker.started('https://example.test/p')
  tracker.committed('https://example.test/q', null)
  expect(tracker.freshlyNavigated()).toBe(true)
  tracker.started('https://example.test/q')
  expect(tracker.committed('https://example.test/q', null)).toBe(false)
})

it('keeps a redirect target that a reload of a POST result re-POSTed to', () => {
  const tracker = trackerWithPostResult()
  tracker.started('https://example.test/p')
  expect(tracker.committed('https://example.test/q', null)).toBe(true)
  tracker.started('https://example.test/q')
  expect(tracker.committed('https://example.test/q', null)).toBe(true)
})
