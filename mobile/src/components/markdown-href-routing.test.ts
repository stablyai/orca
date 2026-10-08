import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openMarkdownHref, openMarkdownImage, routeMarkdownHref } from './markdown-href-routing'

const openExternalLink = vi.hoisted(() => vi.fn())

vi.mock('../platform/external-link', () => ({ openExternalLink }))

beforeEach(() => {
  openExternalLink.mockClear()
})

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

  it('drops anchors, unknown schemes, and empty hrefs', () => {
    expect(routeMarkdownHref('#section')).toEqual({ kind: 'none' })
    expect(routeMarkdownHref('')).toEqual({ kind: 'none' })
    expect(routeMarkdownHref('editor://file/x.ts')).toEqual({ kind: 'none' })
    expect(routeMarkdownHref('javascript:alert(1)')).toEqual({ kind: 'none' })
    expect(routeMarkdownHref('data:text/plain,hi')).toEqual({ kind: 'none' })
  })
})

describe('openMarkdownHref', () => {
  it('opens web hrefs on the system handler and file hrefs on the file opener', () => {
    const onOpenFile = vi.fn()
    openMarkdownHref('https://example.com/docs', onOpenFile)
    expect(openExternalLink).toHaveBeenCalledWith('https://example.com/docs')
    openMarkdownHref('docs/plan.md#L7', onOpenFile)
    expect(onOpenFile).toHaveBeenCalledWith('docs/plan.md:7')
  })
})

describe('openMarkdownImage', () => {
  it('sends a relative src to the dedicated image handler, never the file opener', () => {
    const onOpenFile = vi.fn()
    const onOpenImage = vi.fn()
    openMarkdownImage('docs/shot.png', onOpenFile, onOpenImage)
    expect(onOpenImage).toHaveBeenCalledWith('docs/shot.png')
    expect(onOpenFile).not.toHaveBeenCalled()
    expect(openExternalLink).not.toHaveBeenCalled()
  })

  it('routes an external src as a web href even with the image handler present', () => {
    const onOpenFile = vi.fn()
    const onOpenImage = vi.fn()
    openMarkdownImage('https://example.com/chart.png', onOpenFile, onOpenImage)
    expect(openExternalLink).toHaveBeenCalledWith('https://example.com/chart.png')
    expect(onOpenImage).not.toHaveBeenCalled()
    expect(onOpenFile).not.toHaveBeenCalled()
  })

  it('routes the src as a href when no image handler is provided', () => {
    const onOpenFile = vi.fn()
    openMarkdownImage('docs/shot.png', onOpenFile)
    expect(onOpenFile).toHaveBeenCalledWith('docs/shot.png')
  })
})
