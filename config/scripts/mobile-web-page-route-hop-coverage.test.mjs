import { describe, expect, it } from 'vitest'
import { mobileAppNavigationTargets } from './mobile-app-navigation-targets.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from './mobile-web-page-routes.mjs'

/**
 * Every in-page hop between page routes, and whether the opener's grants cover the target.
 *
 * Grants are resolved once, from the route the shell opened, so a push kept inside the document
 * runs the target under the opener's list. C2.9 made the handoff refuse to keep a hop it cannot
 * cover, which is the fix; this is the census that says which hops those are, so adding a grant to
 * a route — or a new push between two — shows up as a change here rather than as a verb that
 * silently refuses on a device.
 *
 * Openers are every page route, not the one that pushes: on a wide layout `app/h/_layout.tsx`
 * renders the worktree-list sidebar beside every `/h` route, and its header pushes tasks. That is
 * what makes a pairwise pin the wrong shape — the sidebar reaches everything.
 *
 * Targets are the routes the app navigates to, read from its call sites rather than from every
 * `/h/...` template in the sources: a route's own mount declares its pathname, so harvesting those
 * made every declared route reachable and the filter inert.
 */

/** Whether a concrete pattern from the source names the same route as a manifest pattern. */
function sameRoute(pushed, declared) {
  const a = pushed.split('/')
  const b = declared.split('/')
  if (a.length !== b.length) {
    return false
  }
  return a.every((segment, index) => {
    const other = b[index]
    const dynamic = (value) => value?.startsWith('[') === true
    return dynamic(segment) || dynamic(other) ? true : segment === other
  })
}

/**
 * Which hops the rule hands to the shell, pinned by name.
 *
 * Empty would mean every page route covers every other, which is not a property this codebase has
 * and not one to assume: the point of the pin is that a new entry appears when a route's grants
 * grow, and that the entry is read before it ships rather than found on a device.
 *
 * What is NOT here is the point of the census. `files/[worktreeId] -> files/preview/[worktreeId]`
 * is absent because the preview declares no more than the explorer, so that hop stays in the
 * document — which is C3.1's pairwise pin, now a consequence of the rule rather than a rule of its
 * own. The two `-> tasks` entries and the four `-> files/*` entries are the hops the sidebar and
 * the rows make into a route that asks for more than their opener holds.
 *
 * Absent for the same reason, and the reason C4 registered its two routes in one PR:
 * `source-control ⇄ review` in both directions. The hub's rows push review and review replaces
 * back, and the two declare the same five grants, so both hops stay in the document. Either one
 * landing alone would have put a handoff — a new native screen and a new bridge session — between
 * a changed-file row and its diff.
 */
const HANDED_OFF = [
  '/h/[hostId] -> /h/[hostId]/files/[worktreeId]',
  '/h/[hostId] -> /h/[hostId]/files/preview/[worktreeId]',
  '/h/[hostId] -> /h/[hostId]/review/[worktreeId]',
  '/h/[hostId] -> /h/[hostId]/source-control/[worktreeId]',
  '/h/[hostId] -> /h/[hostId]/tasks',
  '/h/[hostId]/agent-history/[worktreeId] -> /h/[hostId]/files/[worktreeId]',
  '/h/[hostId]/agent-history/[worktreeId] -> /h/[hostId]/files/preview/[worktreeId]',
  '/h/[hostId]/agent-history/[worktreeId] -> /h/[hostId]/review/[worktreeId]',
  '/h/[hostId]/agent-history/[worktreeId] -> /h/[hostId]/source-control/[worktreeId]',
  '/h/[hostId]/agent-history/[worktreeId] -> /h/[hostId]/tasks',
  '/h/[hostId]/files/[worktreeId] -> /h/[hostId]/review/[worktreeId]',
  '/h/[hostId]/files/[worktreeId] -> /h/[hostId]/source-control/[worktreeId]',
  '/h/[hostId]/files/[worktreeId] -> /h/[hostId]/tasks',
  '/h/[hostId]/files/preview/[worktreeId] -> /h/[hostId]/review/[worktreeId]',
  '/h/[hostId]/files/preview/[worktreeId] -> /h/[hostId]/source-control/[worktreeId]',
  '/h/[hostId]/files/preview/[worktreeId] -> /h/[hostId]/tasks'
]

describe('in-page hops between page routes', () => {
  it('finds the hops the app actually builds, so the census is not empty', () => {
    const { targets } = mobileAppNavigationTargets()
    // The sidebar's tasks push is the hop this lane exists for; if the census stops seeing it the
    // pin below would go quietly green. Deleting the header's two pushes reds this case, which is
    // what the derivation bought: the tasks screen still declares its own pathname.
    expect(targets.some((pattern) => sameRoute(pattern, '/h/[hostId]/tasks'))).toBe(true)
  })

  it('pins every hop the handoff must take away from the page', () => {
    const pushed = mobileAppNavigationTargets().targets
    const handedOff = []
    for (const opener of MOBILE_WEB_PAGE_ROUTES) {
      for (const target of MOBILE_WEB_PAGE_ROUTES) {
        if (target.pathname === opener.pathname) {
          continue
        }
        const reachable = pushed.some((pattern) => sameRoute(pattern, target.pathname))
        if (!reachable) {
          continue
        }
        const covered = target.grants.every((grant) => opener.grants.includes(grant))
        if (!covered) {
          handedOff.push(`${opener.pathname} -> ${target.pathname}`)
        }
      }
    }
    expect(handedOff.sort()).toEqual([...HANDED_OFF].sort())
  })

  it('covers a hop whose target asks for no more than its opener, rather than handing it off', () => {
    // The other half of the rule, asserted on the manifest rather than assumed: a target declaring
    // a subset stays in the document, which is what keeps an ordinary hop cheap.
    // The explorer to its own preview, which is the hop C3.1 pinned pairwise: the preview asks for
    // no more than the explorer, so the rule keeps it local and the pairwise pin is redundant.
    const explorer = MOBILE_WEB_PAGE_ROUTES.find(
      (route) => route.pathname === '/h/[hostId]/files/[worktreeId]'
    )
    const preview = MOBILE_WEB_PAGE_ROUTES.find(
      (route) => route.pathname === '/h/[hostId]/files/preview/[worktreeId]'
    )
    if (!explorer || !preview) {
      throw new Error('the manifest lost a route this census is written against')
    }
    expect(preview.grants.length, 'the preview declares something to inherit').toBeGreaterThan(0)
    expect(preview.grants.filter((grant) => !explorer.grants.includes(grant))).toEqual([])
  })

  it('keeps the hub and review local to each other, in both directions', () => {
    // The pair C4 registered together. Asserted as equality of the two grant lists rather than as
    // the absence of two rows above: absent is also what an unregistered route looks like, and the
    // hop that matters — a changed-file row opening its diff — would read as covered either way.
    const grantsOf = (pathname) => {
      const route = MOBILE_WEB_PAGE_ROUTES.find((entry) => entry.pathname === pathname)
      if (!route) {
        throw new Error(`${pathname} is not registered`)
      }
      return [...route.grants].sort()
    }
    const hub = grantsOf('/h/[hostId]/source-control/[worktreeId]')
    expect(hub.length).toBeGreaterThan(0)
    expect(grantsOf('/h/[hostId]/review/[worktreeId]')).toEqual(hub)
  })
})
