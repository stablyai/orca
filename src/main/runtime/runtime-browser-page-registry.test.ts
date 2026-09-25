import { describe, expect, it } from 'vitest'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

describe('runtime browser page registry', () => {
  it('publishes an immutable client placement with its logical workspace identity', () => {
    const pages = new RuntimeBrowserPageRegistry()
    const placement = {
      kind: 'client' as const,
      browserHostClientId: 'host-a',
      browserHostGeneration: 3,
      pageHostGeneration: 7
    }

    const page = pages.publishClientPage({
      browserPageId: 'page-a',
      workspaceId: 'worktree-a',
      browserProfileId: 'profile-a',
      executionHostKey: 'ssh:target-a:4',
      placement,
      url: 'about:blank',
      loading: false,
      active: true
    })
    placement.pageHostGeneration = 9

    expect(page).toMatchObject({
      browserPageId: 'page-a',
      workspaceId: 'worktree-a',
      browserProfileId: 'profile-a',
      executionHostKey: 'ssh:target-a:4',
      placement: { pageHostGeneration: 7 },
      title: 'Browser',
      url: 'about:blank',
      active: true
    })
    expect(Object.isFrozen(page)).toBe(true)
    expect(Object.isFrozen(page.placement)).toBe(true)
  })

  it('updates metadata only through the exact immutable placement', () => {
    const pages = new RuntimeBrowserPageRegistry()
    const page = pages.publishClientPage(clientPage('page-a', 'worktree-a'))

    expect(
      pages.updatePage(page.browserPageId, page.placement, {
        url: 'https://example.com/',
        title: 'Example',
        loading: false,
        canGoBack: true
      })
    ).toMatchObject({
      url: 'https://example.com/',
      title: 'Example',
      loading: false,
      canGoBack: true
    })
    expect(() =>
      pages.updatePage(
        page.browserPageId,
        { ...page.placement, pageHostGeneration: page.placement.pageHostGeneration + 1 },
        { title: 'stale' }
      )
    ).toThrow('browser_page_placement_stale')
    expect(pages.getPage(page.browserPageId)?.title).toBe('Example')
  })

  it('accepts only newer full client metadata for the exact page generation', () => {
    const pages = new RuntimeBrowserPageRegistry()
    const page = pages.publishClientPage(clientPage('page-a', 'worktree-a'))

    expect(
      pages.updatePageMetadata(page.browserPageId, page.placement, {
        revision: 2,
        url: 'https://remote.internal/new',
        title: 'Remote page',
        loading: false,
        canGoBack: true,
        canGoForward: false
      })
    ).toBe(true)
    expect(
      pages.updatePageMetadata(page.browserPageId, page.placement, {
        revision: 1,
        url: 'https://stale.invalid/',
        title: 'Stale page',
        loading: true,
        canGoBack: false,
        canGoForward: true
      })
    ).toBe(false)
    expect(pages.getPage(page.browserPageId)).toMatchObject({
      metadataRevision: 2,
      url: 'https://remote.internal/new',
      title: 'Remote page'
    })
    expect(() =>
      pages.updatePageMetadata(
        page.browserPageId,
        { ...page.placement, pageHostGeneration: page.placement.pageHostGeneration + 1 },
        {
          revision: 3,
          url: 'https://wrong-generation.invalid/',
          title: 'Wrong generation',
          loading: false,
          canGoBack: false,
          canGoForward: false
        }
      )
    ).toThrow('browser_page_placement_stale')
  })

  it('isolates worktree and folder workspace inventories and one active page per scope', () => {
    const pages = new RuntimeBrowserPageRegistry()
    pages.publishClientPage(clientPage('page-worktree', 'worktree-a'))
    pages.publishClientPage(clientPage('page-folder-a', 'folder:folder-a'))
    pages.publishClientPage({ ...clientPage('page-folder-b', 'folder:folder-a'), active: true })

    expect(pages.listPages('worktree-a').map((page) => page.browserPageId)).toEqual([
      'page-worktree'
    ])
    expect(pages.listPages('folder:folder-a')).toMatchObject([
      { browserPageId: 'page-folder-a', active: false },
      { browserPageId: 'page-folder-b', active: true }
    ])
  })

  it('keeps one global active client page without changing scoped workspace actives', () => {
    const pages = new RuntimeBrowserPageRegistry()
    const worktree = pages.publishClientPage({
      ...clientPage('page-worktree', 'worktree-a'),
      active: true
    })
    pages.publishClientPage({ ...clientPage('page-folder', 'folder:folder-a'), active: true })

    expect(pages.listPages()).toMatchObject([
      { browserPageId: 'page-worktree', active: false },
      { browserPageId: 'page-folder', active: true }
    ])
    expect(pages.listPages('worktree-a')).toMatchObject([
      { browserPageId: 'page-worktree', active: true }
    ])

    pages.deactivateGlobal()
    expect(pages.listPages().every((page) => !page.active)).toBe(true)
    expect(pages.listPages('folder:folder-a')[0]?.active).toBe(true)

    pages.activatePage(worktree.browserPageId, worktree.placement)
    expect(pages.listPages()).toMatchObject([
      { browserPageId: 'page-worktree', active: true },
      { browserPageId: 'page-folder', active: false }
    ])
    expect(pages.retirePage(worktree.browserPageId, worktree.placement)).toBe(true)
    expect(pages.listPages().every((page) => !page.active)).toBe(true)
  })

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

  // Why the revision cannot survive the placement: revisions are minted by the client's page
  // object, and the page a recovered placement lands on is a freshly minted one counting from
  // zero. Carrying the old high-water mark over would reject that client's first N publishes.
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
