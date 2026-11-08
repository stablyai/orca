import { describe, expect, it } from 'vitest'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

describe('runtime browser page registry', () => {
  it('retires only the exact page generation and releases its capacity', () => {
    const pages = new RuntimeBrowserPageRegistry({ maxPages: 1 })
    const page = pages.publishClientPage(clientPage('page-a', 'worktree-a'))

    expect(() => pages.publishClientPage(clientPage('page-b', 'worktree-a'))).toThrow(
      'browser_runtime_page_capacity'
    )
    expect(
      pages.retirePage('page-a', {
        ...page.placement,
        pageHostGeneration: page.placement.pageHostGeneration + 1
      })
    ).toBe(false)
    expect(pages.retirePage('page-a', page.placement)).toBe(true)
    expect(() => pages.publishClientPage(clientPage('page-b', 'worktree-a'))).not.toThrow()
  })

  // Replacement page revisions restart at zero; carrying old high-water rejects its first N publishes.
  it('restarts the metadata revision when a placement is replaced', () => {
    const pages = new RuntimeBrowserPageRegistry()
    const page = pages.publishClientPage(clientPage('page-a', 'worktree-a'))
    expect(
      pages.updatePageMetadata('page-a', page.placement, {
        revision: 5,
        url: 'https://example.internal/before',
        title: 'Before',
        loading: false,
        canGoBack: false,
        canGoForward: false
      })
    ).toBe(true)

    const recovered = { ...page.placement, pageHostGeneration: 9 }
    expect(
      pages.replaceClientPagePlacement('page-a', page.placement, recovered).metadataRevision
    ).toBe(0)
    expect(
      pages.updatePageMetadata('page-a', recovered, {
        revision: 1,
        url: 'https://example.internal/after',
        title: 'After',
        loading: false,
        canGoBack: false,
        canGoForward: false
      }),
      'the replacing host starts at revision 1 and must be heard'
    ).toBe(true)
    expect(pages.getPage('page-a')).toMatchObject({
      metadataRevision: 1,
      url: 'https://example.internal/after'
    })
  })
})

function clientPage(browserPageId: string, workspaceId: string) {
  return {
    browserPageId,
    workspaceId,
    browserProfileId: 'default',
    executionHostKey: 'native:runtime-a:5',
    placement: {
      kind: 'client' as const,
      browserHostClientId: 'host-a',
      browserHostGeneration: 2,
      pageHostGeneration: browserPageId.endsWith('b') ? 2 : 1
    },
    url: 'about:blank',
    loading: false,
    active: false
  }
}
