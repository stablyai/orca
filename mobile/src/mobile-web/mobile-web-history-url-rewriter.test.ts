import { describe, expect, it, vi } from 'vitest'
import {
  installMobileWebHistoryUrlRewriter,
  pinMobileWebShellSessionFragment,
  stripMobileWebRouteQuery
} from './mobile-web-history-url-rewriter'
import { mobileWebRouteQuery } from './mobile-web-route-query-cache'

const SESSION_ID = 'S'.repeat(43)
const REWRITES = [stripMobileWebRouteQuery, pinMobileWebShellSessionFragment]

describe('mobile web history url rewriter', () => {
  it('strips the query and pins the opaque session in one write', () => {
    const target = historyTarget()

    expect(installMobileWebHistoryUrlRewriter(REWRITES, target)).toBe(true)
    target.history.pushState({ page: 1 }, '', '/h/host/session/workspace?name=repo')
    target.history.replaceState({ page: 2 }, '', '/h/host/tasks#other')

    expect(target.pushState).toHaveBeenCalledWith(
      { page: 1 },
      '',
      `https://orca-mobile-web.invalid/h/host/session/workspace#${SESSION_ID}`
    )
    expect(target.replaceState).toHaveBeenCalledWith(
      { page: 2 },
      '',
      `https://orca-mobile-web.invalid/h/host/tasks#${SESSION_ID}`
    )
    expect(mobileWebRouteQuery('/h/host/session/workspace')).toEqual({ name: 'repo' })
  })

  it('clears stale route state for a queryless write', () => {
    const target = historyTarget()
    installMobileWebHistoryUrlRewriter(REWRITES, target)

    target.history.replaceState(null, '', '/h/host/tasks?taskSource=linear')
    target.history.replaceState(null, '', '/h/host/tasks')

    expect(mobileWebRouteQuery('/h/host/tasks')).toEqual({})
  })

  it('leaves cross-origin and invalid URLs to browser enforcement', () => {
    const target = historyTarget()
    installMobileWebHistoryUrlRewriter(REWRITES, target)

    target.history.pushState(null, '', 'https://example.test/path?secret=value')
    target.history.replaceState(null, '', 'http://[')

    expect(target.pushState).toHaveBeenCalledWith(
      null,
      '',
      'https://example.test/path?secret=value'
    )
    expect(target.replaceState).toHaveBeenCalledWith(null, '', 'http://[')
  })

  it('leaves a fragment that is not a shell session alone', () => {
    const target = historyTarget({ hash: '#short' })
    installMobileWebHistoryUrlRewriter(REWRITES, target)

    target.history.pushState(null, '', '/h/host/tasks#other')

    expect(target.pushState).toHaveBeenCalledWith(
      null,
      '',
      'https://orca-mobile-web.invalid/h/host/tasks#other'
    )
  })

  it('applies each rewrite in the order it was given', () => {
    const target = historyTarget()
    const order: string[] = []
    installMobileWebHistoryUrlRewriter(
      [() => order.push('first'), () => order.push('second')],
      target
    )

    target.history.pushState(null, '', '/h/host/tasks')

    expect(order).toEqual(['first', 'second'])
  })

  it('does not wrap an already wrapped history', () => {
    const target = historyTarget()

    expect(installMobileWebHistoryUrlRewriter(REWRITES, target)).toBe(true)
    expect(installMobileWebHistoryUrlRewriter(REWRITES, target)).toBe(false)
  })
})

function historyTarget(overrides: { hash?: string } = {}) {
  const pushState = vi.fn()
  const replaceState = vi.fn()
  return {
    pushState,
    replaceState,
    history: { pushState, replaceState },
    location: {
      hash: overrides.hash ?? `#${SESSION_ID}`,
      href: `https://orca-mobile-web.invalid/#${SESSION_ID}`,
      origin: 'https://orca-mobile-web.invalid'
    }
  }
}
