import { describe, expect, it } from 'vitest'
import {
  implementedPageRoutes,
  matchesRoutePattern,
  pageRendersRoute,
  MOBILE_WEB_SHELL_GRANTS
} from './page-route-policy'

describe('matching a concrete route against a pattern', () => {
  it('matches a dynamic segment against one segment and never against a path', () => {
    expect(matchesRoutePattern('/h/host-1', '/h/[hostId]')).toBe(true)
    // The session screen starts with the same two segments and is a different screen. Matching it
    // here would open the page for a route it does not carry.
    expect(matchesRoutePattern('/h/host-1/session/wt-1', '/h/[hostId]')).toBe(false)
    expect(matchesRoutePattern('/h', '/h/[hostId]')).toBe(false)
  })

  it('refuses an empty dynamic segment, which is a path with a hole in it', () => {
    expect(matchesRoutePattern('/h/', '/h/[hostId]')).toBe(false)
  })

  it('matches a static segment exactly, case and all', () => {
    expect(matchesRoutePattern('/h/host-1/tasks', '/h/[hostId]/tasks')).toBe(true)
    expect(matchesRoutePattern('/h/host-1/Tasks', '/h/[hostId]/tasks')).toBe(false)
    expect(matchesRoutePattern('/h/host-1/accounts', '/h/[hostId]/tasks')).toBe(false)
  })

  it('matches a pattern with several dynamic segments', () => {
    expect(matchesRoutePattern('/h/a/session/b', '/h/[hostId]/session/[worktreeId]')).toBe(true)
    expect(matchesRoutePattern('/h/a/session', '/h/[hostId]/session/[worktreeId]')).toBe(false)
  })
})

describe('the routes this shell will render from the page', () => {
  it('keeps a route whose grants it implements', () => {
    expect(implementedPageRoutes([{ pathname: '/h/[hostId]', grants: ['navigate'] }])).toEqual([
      '/h/[hostId]'
    ])
    expect(implementedPageRoutes([{ pathname: '/h/[hostId]', grants: [] }])).toEqual([
      '/h/[hostId]'
    ])
  })

  it('drops a route needing a grant this app has never heard of', () => {
    // The whole point of the negotiation: a newer desktop shipping a screen that needs more than
    // this app can do leaves that one route native rather than handing it a dead tap.
    expect(
      implementedPageRoutes([
        { pathname: '/h/[hostId]', grants: ['navigate', 'teleport'] },
        { pathname: '/h/[hostId]/tasks', grants: ['navigate'] }
      ])
    ).toEqual(['/h/[hostId]/tasks'])
  })

  it('answers nothing for a desktop older than the field', () => {
    expect(implementedPageRoutes(undefined)).toEqual([])
    expect(pageRendersRoute(undefined, '/h/host-1')).toBe(false)
  })

  it('answers the two halves of the negotiation together', () => {
    const routes = [{ pathname: '/h/[hostId]', grants: ['navigate'] }]
    expect(pageRendersRoute(routes, '/h/host-1')).toBe(true)
    expect(pageRendersRoute(routes, '/h/host-1/tasks')).toBe(false)
    expect(pageRendersRoute([], '/h/host-1')).toBe(false)
  })
})

describe('the grants this app implements', () => {
  it('names exactly what the shell honours over the bridge', () => {
    // The same list `init.grants.native` gives the page. A name here with nothing behind it is a
    // route the desktop will hand over and the page will find it cannot use.
    expect([...MOBILE_WEB_SHELL_GRANTS]).toEqual(['navigate', 'storage', 'externalLink'])
  })
})
