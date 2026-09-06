// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchMobileWebBackNavigation,
  installMobileWebBackNavigationAdapter
} from './mobile-web-back-navigation-adapter'

vi.mock('react-native', () => ({ BackHandler: {} }))

afterEach(() => vi.useRealTimers())

describe('mobile web BackHandler adapter', () => {
  it('restores the current entry before dispatching a handled browser back', () => {
    const harness = navigationHarness()
    const backHandler = backHandlerTarget()
    installMobileWebBackNavigationAdapter(backHandler, harness.target)
    harness.target.history.pushState({}, '', '/files')
    harness.target.history.pushState({}, '', '/preview')
    const observed: string[] = []
    harness.target.addEventListener('popstate', () => observed.push(harness.target.location.href))
    backHandler.addEventListener('hardwareBackPress', () => true)

    harness.browserBack()

    expect(harness.target.location.href).toBe('https://orca.test/preview')
    expect(observed).toEqual([])
  })

  it('lets the native callback perform one programmatic back after restoration', () => {
    const harness = navigationHarness()
    const backHandler = backHandlerTarget()
    installMobileWebBackNavigationAdapter(backHandler, harness.target)
    harness.target.history.pushState({}, '', '/files')
    harness.target.history.pushState({}, '', '/preview')
    const observed: string[] = []
    harness.target.addEventListener('popstate', () => observed.push(harness.target.location.href))
    backHandler.addEventListener('hardwareBackPress', () => {
      harness.target.history.back()
      return true
    })

    harness.browserBack()

    expect(harness.target.location.href).toBe('https://orca.test/files')
    expect(observed).toEqual(['https://orca.test/files'])
  })

  it('dispatches the newest active handler first', () => {
    const harness = navigationHarness()
    const backHandler = backHandlerTarget()
    installMobileWebBackNavigationAdapter(backHandler, harness.target)
    harness.target.history.pushState({}, '', '/files')
    harness.target.history.pushState({}, '', '/preview')
    const older = vi.fn(() => true)
    const newer = vi.fn(() => true)
    backHandler.addEventListener('hardwareBackPress', older)
    const subscription = backHandler.addEventListener('hardwareBackPress', newer)

    harness.browserBack()
    expect(newer).toHaveBeenCalledOnce()
    expect(older).not.toHaveBeenCalled()

    subscription.remove()
    harness.browserBack()
    expect(older).toHaveBeenCalledOnce()
  })

  it('lets a dirty-route handler consume an explicit hardware back request', () => {
    const harness = navigationHarness()
    const backHandler = backHandlerTarget()
    installMobileWebBackNavigationAdapter(backHandler, harness.target)
    harness.target.history.pushState({}, '', '/files')
    harness.target.history.pushState({}, '', '/preview')
    const dirtyDraftHandler = vi.fn(() => true)
    backHandler.addEventListener('hardwareBackPress', dirtyDraftHandler)

    expect(dispatchMobileWebBackNavigation(harness.target)).toBe(true)
    expect(dirtyDraftHandler).toHaveBeenCalledOnce()
    expect(harness.target.location.href).toBe('https://orca.test/preview')
  })

  it('returns an unconsumed request through page history', () => {
    const harness = navigationHarness()
    const backHandler = backHandlerTarget()
    installMobileWebBackNavigationAdapter(backHandler, harness.target)
    harness.target.history.pushState({}, '', '/files')
    harness.target.history.pushState({}, '', '/preview')
    backHandler.addEventListener('hardwareBackPress', () => false)

    expect(dispatchMobileWebBackNavigation(harness.target)).toBe(true)
    expect(harness.target.location.href).toBe('https://orca.test/files')
  })

  it('returns false at the page root so the native shell can leave the route', () => {
    const harness = navigationHarness()
    const backHandler = backHandlerTarget()
    installMobileWebBackNavigationAdapter(backHandler, harness.target)

    expect(dispatchMobileWebBackNavigation(harness.target)).toBe(false)
    expect(harness.target.location.href).toBe('https://orca.test/')
  })

  it('does not redispatch a delayed programmatic traversal as physical Back', () => {
    vi.useFakeTimers()
    const harness = navigationHarness(500)
    const backHandler = backHandlerTarget()
    installMobileWebBackNavigationAdapter(backHandler, harness.target)
    harness.target.history.pushState({}, '', '/files')
    harness.target.history.pushState({}, '', '/preview')
    const handler = vi.fn(() => false)
    backHandler.addEventListener('hardwareBackPress', handler)

    harness.target.history.back()
    vi.advanceTimersByTime(500)

    expect(harness.target.location.href).toBe('https://orca.test/files')
    expect(handler).not.toHaveBeenCalled()
  })

  it('tracks rapid delayed Back traversals independently', () => {
    vi.useFakeTimers()
    const harness = navigationHarness(500)
    const backHandler = backHandlerTarget()
    installMobileWebBackNavigationAdapter(backHandler, harness.target)
    harness.target.history.pushState({}, '', '/files')
    harness.target.history.pushState({}, '', '/preview')
    harness.target.history.pushState({}, '', '/detail')
    const handler = vi.fn(() => {
      harness.target.history.back()
      return true
    })
    backHandler.addEventListener('hardwareBackPress', handler)

    expect(dispatchMobileWebBackNavigation(harness.target)).toBe(true)
    expect(dispatchMobileWebBackNavigation(harness.target)).toBe(true)
    vi.advanceTimersByTime(500)

    expect(handler).toHaveBeenCalledTimes(2)
    expect(harness.target.location.href).toBe('https://orca.test/files')
  })
})

function backHandlerTarget() {
  return {
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    removeEventListener: vi.fn()
  }
}

function navigationHarness(eventDelayMs = 0) {
  const events = new EventTarget()
  const location = { href: 'https://orca.test/' }
  let entries = [{ state: null as unknown, href: location.href }]
  let index = 0
  const traverse = (delta: number): void => {
    const nextIndex = Math.max(0, Math.min(entries.length - 1, index + delta))
    if (nextIndex === index) {
      return
    }
    index = nextIndex
    location.href = entries[index]!.href
    const state = entries[index]!.state
    const dispatch = () => events.dispatchEvent(new PopStateEvent('popstate', { state }))
    if (eventDelayMs > 0) {
      setTimeout(dispatch, eventDelayMs)
    } else {
      dispatch()
    }
  }
  const history = {
    get state() {
      return entries[index]!.state
    },
    pushState(data: unknown, _unused: string, url?: string | URL | null) {
      const href = url == null ? location.href : new URL(String(url), location.href).href
      entries = entries.slice(0, index + 1)
      entries.push({ state: data, href })
      index += 1
      location.href = href
    },
    replaceState(data: unknown, _unused: string, url?: string | URL | null) {
      const href = url == null ? location.href : new URL(String(url), location.href).href
      entries[index] = { state: data, href }
      location.href = href
    },
    go(delta = 0) {
      traverse(delta)
    },
    back() {
      traverse(-1)
    },
    forward() {
      traverse(1)
    }
  } as History
  const target = {
    history,
    location,
    addEventListener: events.addEventListener.bind(events)
  }
  return { target, browserBack: () => traverse(-1) }
}
