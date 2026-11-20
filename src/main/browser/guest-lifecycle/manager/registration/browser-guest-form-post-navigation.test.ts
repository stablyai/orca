import { expect, it } from 'vitest'
import { createFormPostNavigationTracker } from './browser-guest-form-post-navigation'

function trackerWithPostResult(): ReturnType<typeof createFormPostNavigationTracker> {
  const tracker = createFormPostNavigationTracker()
  tracker.submitted('https://example.test/p', 1)
  tracker.started('https://example.test/p', 1)
  tracker.committed('https://example.test/p', null)
  return tracker
}

it('forgets a redirect target when the remembered address was reached by a fresh link', () => {
  const tracker = trackerWithPostResult()
  tracker.started('https://example.test/p', 1)
  tracker.committed('https://example.test/q', null)
  expect(tracker.freshlyNavigated()).toBe(true)
  tracker.started('https://example.test/q', 1)
  expect(tracker.committed('https://example.test/q', null)).toBe(false)
})

it('keeps a redirect target that a reload of a POST result re-POSTed to', () => {
  const tracker = trackerWithPostResult()
  tracker.started('https://example.test/p', 1)
  expect(tracker.committed('https://example.test/q', null)).toBe(true)
  tracker.started('https://example.test/q', 1)
  expect(tracker.committed('https://example.test/q', null)).toBe(true)
})

it("doesn't mark a later visit to a form's address after the page cancelled its navigation", () => {
  const tracker = createFormPostNavigationTracker()
  tracker.submitted('https://example.test/search', 1)
  tracker.cancelled('https://example.test/search')
  tracker.started('https://example.test/search', 1)
  expect(tracker.committed('https://example.test/search', null)).toBe(false)
})

it('keeps the oldest POST result when a fresh link disproves a redirect target', () => {
  const tracker = createFormPostNavigationTracker()
  for (let i = 0; i < 50; i += 1) {
    tracker.submitted(`https://example.test/p${i}`, 1)
    tracker.started(`https://example.test/p${i}`, 1)
    tracker.committed(`https://example.test/p${i}`, null)
  }
  tracker.started('https://example.test/p49', 1)
  tracker.committed('https://example.test/q', null)
  tracker.freshlyNavigated()
  tracker.started('https://example.test/p0', 1)
  expect(tracker.committed('https://example.test/p0', null)).toBe(true)
})

it("keeps a newer submission when an older one's navigation is cancelled", () => {
  const tracker = createFormPostNavigationTracker()
  tracker.submitted('https://example.test/a', 1)
  tracker.submitted('https://example.test/b', 2)
  tracker.cancelled('https://example.test/a')
  tracker.started('https://example.test/b', 2)
  expect(tracker.committed('https://example.test/b', null)).toBe(true)
})

it("doesn't take a visit the reporting frame didn't start for its submission", () => {
  const tracker = createFormPostNavigationTracker()
  tracker.submitted('https://example.test/result', 2)
  tracker.started('https://example.test/result', 1)
  expect(tracker.committed('https://example.test/result', null)).toBe(false)
  tracker.submitted('https://example.test/result', 2)
  tracker.started('https://example.test/result', null)
  expect(tracker.committed('https://example.test/result', null)).toBe(false)
})
