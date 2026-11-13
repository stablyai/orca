import { describe, expect, it } from 'vitest'
import { routeMarkdownHref } from './markdown-href-routing'

describe('routeMarkdownHref', () => {
  it('carries a #L fragment as a :line suffix', () => {
    expect(routeMarkdownHref('docs/plan.md#L42')).toEqual({
      kind: 'file',
      pathText: 'docs/plan.md:42'
    })
    expect(routeMarkdownHref('docs/plan.md?plain=1#line-7')).toEqual({
      kind: 'file',
      pathText: 'docs/plan.md:7'
    })
    expect(routeMarkdownHref('docs/plan.md#usage')).toEqual({
      kind: 'file',
      pathText: 'docs/plan.md'
    })
  })

  it('routes file: URIs to the file opener', () => {
    expect(routeMarkdownHref('file:///Users/me/wt/src/app.tsx')).toEqual({
      kind: 'file',
      pathText: '/Users/me/wt/src/app.tsx'
    })
    expect(routeMarkdownHref('file:///Users/me/wt/src/app.tsx#L12')).toEqual({
      kind: 'file',
      pathText: '/Users/me/wt/src/app.tsx:12'
    })
    expect(routeMarkdownHref('file:///C:/repo/src/index.ts')).toEqual({
      kind: 'file',
      pathText: 'C:/repo/src/index.ts'
    })
  })
})
