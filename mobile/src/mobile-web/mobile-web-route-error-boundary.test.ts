import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))

import { MobileWebRouteErrorBoundary } from '../../host-web-app/mobile-web-route-error-boundary'
import { mobileWebRouteFailureCode } from './mobile-web-route-failure-code'

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('mobile web route failure classification', () => {
  it.each([
    [new Error('Maximum update depth exceeded'), 'react-update-loop'],
    [new Error('Minified React error #185'), 'react-update-loop'],
    [new Error('ResizeObserver loop completed with undelivered notifications'), 'resize-observer'],
    [new Error('xterm cannot open this terminal'), 'terminal-render'],
    [new TypeError('Cannot read properties of undefined'), 'type-error'],
    [new Error('unexpected'), 'render-error']
  ])('classifies %s as %s', (error, code) => {
    expect(mobileWebRouteFailureCode(error)).toBe(code)
  })

  it('announces recovery while leaving the reload action reachable', () => {
    renderFailedRoute('session')

    const alert = renderer!.root.findByProps({ accessibilityRole: 'alert' })
    expect(alert.props.accessibilityLiveRegion).toBe('assertive')
    expect(alert.props.accessibilityLabel).toContain('Workspace view stopped')
    expect(renderer!.root.findByProps({ accessibilityRole: 'header' })).toBeDefined()
    expect(renderer!.root.findByProps({ accessibilityRole: 'button' }).props).toMatchObject({
      accessibilityLabel: 'Reload interface'
    })
  })

  it('returns to the allowed document root before reloading', () => {
    const historyState = { id: 'route-entry' }
    const replaceState = vi.fn()
    const reload = vi.fn(() => {
      expect(replaceState).toHaveBeenCalledWith(historyState, '', '/')
    })
    vi.stubGlobal('window', {
      history: { replaceState, state: historyState },
      location: { reload }
    })
    renderFailedRoute('session')

    act(() => renderer!.root.findByProps({ accessibilityRole: 'button' }).props.onPress())

    expect(replaceState).toHaveBeenCalledOnce()
    expect(reload).toHaveBeenCalledOnce()
  })

  it.each(['tasks', 'accounts'])('releases a failed route for a new %s route', (route) => {
    renderFailedRoute('session')

    act(() => {
      renderer!.update(
        createElement(
          MobileWebRouteErrorBoundary,
          { resetKey: route },
          createElement('route', { name: route })
        )
      )
    })

    expect(renderer!.root.findByType('route').props.name).toBe(route)
  })
})

function renderFailedRoute(resetKey: string): void {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  act(() => {
    renderer = create(
      createElement(MobileWebRouteErrorBoundary, { resetKey }, createElement(FailedRoute))
    )
  })
}

function FailedRoute(): never {
  throw new Error('route failed')
}
