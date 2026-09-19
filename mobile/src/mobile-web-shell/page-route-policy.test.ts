import { describe, expect, it } from 'vitest'
import {
  implementedPageRoutes,
  matchesRoutePattern,
  pageRendersRoute,
  MOBILE_WEB_SHELL_GRANTS,
  grantsForRoute
} from './page-route-policy'
import {
  BRIDGE_NATIVE_METHOD_PREFIX,
  BRIDGE_NATIVE_VERB_NAMES,
  BRIDGE_NATIVE_VERBS
} from './bridge/bridge-native-verbs'

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
    expect([...MOBILE_WEB_SHELL_GRANTS]).toEqual([
      'navigate',
      'storage',
      'externalLink',
      'native.clipboard.write',
      'native.clipboard.read'
    ])
  })
})

/**
 * A verb cannot be advertised without a handler, or handled without being advertised.
 *
 * The table is keyed on the same tuple this list spreads, so a missing row does not compile. This
 * is the other direction: a name reaching `init.grants.native` that the table has never heard of,
 * which a page would then be told it may call.
 */
describe('the native verbs this app serves', () => {
  it('advertises exactly the verbs the table holds', () => {
    const advertised = MOBILE_WEB_SHELL_GRANTS.filter((grant) =>
      grant.startsWith(BRIDGE_NATIVE_METHOD_PREFIX)
    )
    expect([...advertised].sort()).toEqual([...BRIDGE_NATIVE_VERB_NAMES].sort())
    expect(Object.keys(BRIDGE_NATIVE_VERBS).sort()).toEqual([...BRIDGE_NATIVE_VERB_NAMES].sort())
  })

  it('names them so a route can declare one, which is what keeps that route native without it', () => {
    // A bundle listing a route that needs the clipboard, against a shell too old to serve it.
    expect(
      implementedPageRoutes([
        { pathname: '/h/[hostId]/tasks', grants: ['navigate', 'native.clipboard.write'] }
      ])
    ).toEqual(['/h/[hostId]/tasks'])
    expect(
      implementedPageRoutes([
        { pathname: '/h/[hostId]/tasks', grants: ['navigate', 'native.dictation.start'] }
      ])
    ).toEqual([])
  })
})

/**
 * What an old phone does with a grant name it has never heard of.
 *
 * Widening what a manifest field may contain is a new optional value crossing to readers that
 * shipped before it. The phone's manifest schema bounds a grant's length and nothing else, on
 * purpose, so an unknown name is not a parse failure that would refuse the whole bundle — it is a
 * grant this build does not implement, and the route carrying it stays native.
 */
describe('a grant name this build has never heard of', () => {
  it('leaves that route native rather than refusing the bundle', () => {
    expect(
      implementedPageRoutes([
        { pathname: '/h/[hostId]', grants: ['navigate'] },
        { pathname: '/h/[hostId]/tasks', grants: ['navigate', 'native.dictation.start'] }
      ])
    ).toEqual(['/h/[hostId]'])
  })

  it('grants nothing from it either, so a route it names is served none of it', () => {
    expect(
      grantsForRoute(
        [{ pathname: '/h/[hostId]', grants: ['navigate', 'native.dictation.start'] }],
        '/h/host-1'
      )
    ).toEqual(['navigate'])
  })

  it('carries a verb the build does implement all the way to the session grants', () => {
    expect(
      grantsForRoute(
        [{ pathname: '/h/[hostId]/tasks', grants: ['navigate', 'native.clipboard.write'] }],
        '/h/host-1/tasks'
      )
    ).toEqual(['navigate', 'native.clipboard.write'])
  })
})
