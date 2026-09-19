import { describe, expect, it } from 'vitest'
import {
  BRIDGE_ROUTE_HREF_PATTERN,
  BRIDGE_ROUTE_PATHNAME_PATTERN
} from '../mobile-web-shell/bridge/bridge-caps'
import { shellRouteHref } from '../mobile-web-shell/bridge/page-bootstrap'
import { stringifyRouteHref } from '../navigation/route-href'
import { createMobileFilePreviewHref } from './mobile-file-preview-route'
import { mobileFileShellRoute } from './mobile-file-shell-route'

/**
 * Every shape of a real file path that the bridge's route vocabulary would refuse as a segment.
 *
 * None of them is refused, and that is the design: the pathname spells only `hostId` and
 * `worktreeId`, and the path itself is a param, where `URLSearchParams` percent-encodes `/`, the
 * space, `#` and the dot segment before any pattern sees them. This is the test that says so for
 * each one rather than for a representative.
 */
const HAZARD_PATHS = [
  'docs/readme.md',
  'src/my file.ts',
  '../etc/passwd',
  'a%2Fb.ts',
  'a#b.ts',
  'docs/日本語.md',
  '/logs/run.txt'
]

/** The path as the other side reads it back out of the query it arrived in. */
function relativePathFromHref(href: string): string | null {
  const query = href.slice(href.indexOf('?') + 1)
  return new URLSearchParams(query).get('relativePath')
}

describe.each(HAZARD_PATHS)('a file path the route carries: %s', (relativePath) => {
  it('is a route the page can be given, and a pathname with no path in it', () => {
    const route = mobileFileShellRoute({
      pathname: '/h/host-1/files/preview/wt-1',
      params: { relativePath, source: 'worktree' }
    })
    expect(route).not.toBeNull()
    expect(BRIDGE_ROUTE_PATHNAME_PATTERN.test(route?.pathname ?? '')).toBe(true)
  })

  it('survives the href the shell writes into the page history', () => {
    const href = shellRouteHref({
      pathname: '/h/host-1/files/preview/wt-1',
      params: { relativePath, source: 'worktree' }
    })
    expect(BRIDGE_ROUTE_HREF_PATTERN.test(href)).toBe(true)
    expect(relativePathFromHref(href)).toBe(relativePath)
  })

  it('survives the href the page would hand back to the shell', () => {
    const href = stringifyRouteHref(
      createMobileFilePreviewHref({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        relativePath,
        source: 'worktree'
      })
    )
    expect(BRIDGE_ROUTE_HREF_PATTERN.test(href)).toBe(true)
    expect(relativePathFromHref(href)).toBe(relativePath)
  })
})

describe('what the route vocabulary does refuse', () => {
  it('refuses the same path spelled as a segment, which is why it never is one', () => {
    // The counterfactual the cases above depend on: if the segment rule admitted these, the
    // encoding would not be what is keeping them safe and this file would prove nothing.
    for (const relativePath of ['../etc/passwd', 'src/my file.ts', 'a#b.ts']) {
      expect(BRIDGE_ROUTE_PATHNAME_PATTERN.test(`/h/host-1/files/preview/${relativePath}`)).toBe(
        false
      )
    }
  })

  it('refuses a fragment even in the query half, so a path carrying one has to be encoded', () => {
    expect(BRIDGE_ROUTE_HREF_PATTERN.test('/h/host-1/files/preview/wt-1?relativePath=a#b.ts')).toBe(
      false
    )
  })
})
