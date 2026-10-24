// @vitest-environment happy-dom
import { useAppStore } from '@/store'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useVisibleHostedReviewRefresh } from './use-visible-hosted-review-refresh'

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(async () => true),
  web: vi.fn(() => false)
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: mocks.web }))
vi.mock('@/store/github/visible-hosted-review-refresh-targets', () => ({
  visibleHostedReviewRefreshInputsChanged: () => true,
  getVisibleHostedReviewWorkspaces: () => [],
  getVisibleHostedReviewRefreshTargets: () => [
    {
      key: 'review',
      revision: 'head',
      selected: true,
      intervalMs: 60_000,
      fetchedAt: null,
      refresh: mocks.refresh
    }
  ]
}))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('waits for workspace readiness and stops timers/subscription when disabled', async () => {
  vi.useFakeTimers()
  const watch = useAppStore.subscribe
  const subscribe = vi
    .spyOn(useAppStore, 'subscribe')
    .mockImplementation((listener) => vi.fn(watch(listener)))
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const hook = renderHook(({ enabled }) => useVisibleHostedReviewRefresh({ enabled }), {
    initialProps: { enabled: false }
  })
  await vi.advanceTimersByTimeAsync(600_000)
  expect(mocks.refresh).not.toHaveBeenCalled()
  expect(subscribe).not.toHaveBeenCalled()
  hook.rerender({ enabled: true })
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.refresh).toHaveBeenCalledOnce()
  const unsubscribe = subscribe.mock.results[0].value
  hook.rerender({ enabled: false })
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(600_000)
  expect(mocks.refresh).toHaveBeenCalledOnce()
})
