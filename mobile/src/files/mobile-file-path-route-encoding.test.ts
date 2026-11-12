import { describe, expect, it } from 'vitest'
import { BRIDGE_ROUTE_HREF_PATTERN } from '../mobile-web-shell/bridge/bridge-caps'

import { stringifyRouteHref } from '../navigation/route-href'
import { createMobileFilePreviewHref } from './mobile-file-preview-route'

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
