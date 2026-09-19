import { describe, expect, it } from 'vitest'
import {
  BRIDGE_ROUTE_HREF_PATTERN,
  BRIDGE_ROUTE_PATHNAME_PATTERN
} from '../mobile-web-shell/bridge/bridge-caps'
import { shellRouteHref } from '../mobile-web-shell/bridge/page-bootstrap'
import { stringifyRouteHref } from '../navigation/route-href'
import { createMobileFilePreviewHref } from './mobile-file-preview-route'
import { shellScreenRoute } from '../mobile-web-shell/shell-screen-route'

/**
 * Every shape of a real file path that the bridge's route vocabulary would refuse as a segment.
 *
 * None of them is refused, and that is the design: the pathname spells only `hostId` and
 * `worktreeId`, and the path itself is a param. This is the test that says so for each one rather
 * than for a representative.
 *
 * What the percent-encoding is load-bearing for is narrower than "every path", and the two lists
 * below are that split rather than a claim over the whole set. Two different rules decide it, and
 * neither is about paths:
 *
 *  - the query half of `BRIDGE_ROUTE_HREF_PATTERN` is `[^#\s]*`, so it refuses whitespace of any
 *    kind and a `#`, and admits everything else verbatim;
 *  - the reader is `URLSearchParams`, which is form-urlencoded: it takes `&` as the end of the
 *    pair, `+` as a space, and `%XX` as an escape.
 *
 * So a value needs the encoder exactly when it carries whitespace, `#`, `&`, `+`, or a `%` that
 * begins a valid escape. A `/`, a dot segment, an `=` after the first one, a lone `%` and non-ASCII
 * all pass both rules untouched. That is why hand-joining the query in `stringifyRouteHref` reds
 * some of these paths and not others, and why this file pins the two groups by behaviour instead
 * of asserting one rule over a list of paths.
 */
const ENCODING_LOAD_BEARING = [
  'src/my file.ts',
  'a%2Fb.ts',
  'a#b.ts',
  // `+` decodes to a space and `&` ends the pair, so both come back as a different path entirely.
  'a+b.ts',
  'a&b.ts',
  // Whitespace is whitespace to the pattern, so this one is refused rather than altered.
  'a\nb.ts'
]
const ENCODING_NEUTRAL = [
  'docs/readme.md',
  '../etc/passwd',
  'docs/日本語.md',
  '/logs/run.txt',
  // Only the first `=` splits the pair, and a `%` that begins no valid escape is left alone.
  'a=b.ts',
  'a%b.ts'
]
const HAZARD_PATHS = [...ENCODING_LOAD_BEARING, ...ENCODING_NEUTRAL]

/** The path as the other side reads it back out of the query it arrived in. */
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

/**
 * Which of the seven the encoder is the only thing standing between and a refused or altered href.
 *
 * Asserted by building the href the unencoded way and reading what happens to it, so the split is
 * pinned by behaviour rather than by a comment: move a path between the two lists and this fails.
 */
describe('what the percent-encoding is load-bearing for', () => {
  const rawHref = (relativePath: string) =>
    `/h/host-1/files/preview/wt-1?relativePath=${relativePath}&source=worktree`

  it.each(ENCODING_NEUTRAL)('survives the query unencoded: %s', (relativePath) => {
    const href = rawHref(relativePath)
    expect(BRIDGE_ROUTE_HREF_PATTERN.test(href)).toBe(true)
    expect(relativePathFromHref(href)).toBe(relativePath)
  })

  it.each(ENCODING_LOAD_BEARING)('does not survive the query unencoded: %s', (relativePath) => {
    const href = rawHref(relativePath)
    const refused = !BRIDGE_ROUTE_HREF_PATTERN.test(href)
    const altered = relativePathFromHref(href) !== relativePath
    expect(refused || altered).toBe(true)
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
