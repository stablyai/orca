import { describe, expect, it } from 'vitest'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

describe('runtime browser page registry', () => {
  it('stores redacted client metadata only after the exact placement passes admission', () => {
    const pages = new RuntimeBrowserPageRegistry()
    const raw = 'https://kagi.com/search?token=test-only&q=one'
    const page = pages.publishClientPage({
      ...clientPage('page-a', 'folder-a'),
      url: raw,
      title: raw
    })
    expect(page.url).toBe('https://kagi.com/search?q=one')
    expect(page.title).toBe('https://kagi.com/search?q=one')
    expect(() =>
      pages.updatePage('page-a', { ...page.placement, pageHostGeneration: 77 }, { url: raw })
    ).toThrow('browser_page_placement_stale')
    expect(pages.updatePage('page-a', page.placement, { url: raw, title: raw }).url).toBe(
      'https://kagi.com/search?q=one'
    )
    expect(
      pages.updatePageMetadata('page-a', page.placement, {
        revision: 1,
        url: raw,
        title: raw,
        loading: false,
        canGoBack: false,
        canGoForward: false
      })
    ).toBe(true)
    expect(pages.getPage('page-a')?.title).toBe('https://kagi.com/search?q=one')
    expect(pages.listPages('folder-b')).toEqual([])
  })

  // Replacement page revisions restart at zero; carrying old high-water rejects its first N publishes.
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
