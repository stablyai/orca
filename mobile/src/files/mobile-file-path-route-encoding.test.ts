import { describe, expect, it } from 'vitest'
import {
  BRIDGE_ROUTE_HREF_PATTERN,
  BRIDGE_ROUTE_PATHNAME_PATTERN
} from '../mobile-web-shell/bridge/bridge-caps'
import { shellRouteHref } from '../mobile-web-shell/bridge/page-bootstrap'
import { stringifyRouteHref } from '../navigation/route-href'
import { createMobileFilePreviewHref } from './mobile-file-preview-route'
import { shellScreenRoute } from '../mobile-web-shell/shell-screen-route'

const HAZARD_PATHS = [
  'src/my file.ts',
  'a%2Fb.ts',
  'a#b.ts',
  'a+b.ts',
  'a&b.ts',
  'a\nb.ts',
  'docs/readme.md',
  '../etc/passwd',
  'docs/日本語.md',
  '/logs/run.txt',
  'a=b.ts',
  'a%b.ts'
]

function relativePathFromHref(href: string): string | null {
  const query = href.slice(href.indexOf('?') + 1)
  return new URLSearchParams(query).get('relativePath')
}

describe.each(HAZARD_PATHS)('a file path the route carries: %s', (relativePath) => {
  it('is a route the page can be given, and a pathname with no path in it', () => {
    const route = shellScreenRoute({
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
    // Prove these inputs fail segment validation; otherwise the encoding cases above establish no protection.
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
