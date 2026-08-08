import { describe, expect, it } from 'vitest'
import { routeMarkdownHref } from './markdown-href-routing'

describe('routeMarkdownHref', () => {
  it('routes web and mail links to the system handler', () => {
    expect(routeMarkdownHref('https://example.com/docs')).toEqual({
      kind: 'web',
      url: 'https://example.com/docs'
    })
    expect(routeMarkdownHref('http://localhost:3000/')).toEqual({
      kind: 'web',
      url: 'http://localhost:3000/'
    })
    expect(routeMarkdownHref(' mailto:dev@example.com ')).toEqual({
      kind: 'web',
      url: 'mailto:dev@example.com'
    })
  })

  it('routes relative hrefs to the file opener', () => {
    expect(routeMarkdownHref('src/foo.ts')).toEqual({ kind: 'file', pathText: 'src/foo.ts' })
    expect(routeMarkdownHref('./docs/plan.md')).toEqual({
      kind: 'file',
      pathText: './docs/plan.md'
    })
  })

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

  it('decodes percent-encoded href paths', () => {
    expect(routeMarkdownHref('docs/release%20notes.md')).toEqual({
      kind: 'file',
      pathText: 'docs/release notes.md'
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

  it('keeps Windows drive paths out of the scheme filter', () => {
    expect(routeMarkdownHref(String.raw`C:\repo\src\index.ts`)).toEqual({
      kind: 'file',
      pathText: String.raw`C:\repo\src\index.ts`
    })
  })

  it('drops anchors, unknown schemes, and empty hrefs', () => {
    expect(routeMarkdownHref('#section')).toEqual({ kind: 'none' })
    expect(routeMarkdownHref('')).toEqual({ kind: 'none' })
    expect(routeMarkdownHref('editor://file/x.ts')).toEqual({ kind: 'none' })
    expect(routeMarkdownHref('javascript:alert(1)')).toEqual({ kind: 'none' })
    expect(routeMarkdownHref('data:text/plain,hi')).toEqual({ kind: 'none' })
  })
})
