import { describe, expect, it, vi } from 'vitest'
import { runAcceptedMobileSessionTabsEffects } from './mobile-session-tabs-accepted-effects'

type Tab = {
  id: string
  type: 'browser' | 'markdown'
  isActive: boolean
  browserPageId?: string
  isDirty?: boolean
}

describe('runAcceptedMobileSessionTabsEffects', () => {
  it.each(['list', 'stream'] as const)(
    'resolves pending browser focus exactly once from an accepted %s result',
    (source) => {
      let pendingPageId: string | null = 'page-1'
      const activateBrowserTab = vi.fn()
      const options = {
        effectiveTabs: [
          {
            id: 'browser-1',
            type: 'browser' as const,
            isActive: true,
            browserPageId: 'page-1'
          }
        ],
        source,
        getPendingBrowserPageId: () => pendingPageId,
        clearPendingBrowserPageId: (pageId: string) => {
          if (pendingPageId === pageId) {
            pendingPageId = null
          }
        },
        activateBrowserTab,
        markActiveMarkdownStale: vi.fn()
      }

      runAcceptedMobileSessionTabsEffects(options)
      runAcceptedMobileSessionTabsEffects(options)

      expect(pendingPageId).toBeNull()
      expect(activateBrowserTab).toHaveBeenCalledTimes(1)
    }
  )

  it('does not resolve a pending browser omitted by tombstone filtering', () => {
    const activateBrowserTab = vi.fn()
    runAcceptedMobileSessionTabsEffects<Tab>({
      effectiveTabs: [],
      source: 'stream',
      getPendingBrowserPageId: () => 'page-1',
      clearPendingBrowserPageId: vi.fn(),
      activateBrowserTab,
      markActiveMarkdownStale: vi.fn()
    })

    expect(activateBrowserTab).not.toHaveBeenCalled()
  })

  it('marks only an effective active dirty markdown stream tab stale', () => {
    const markActiveMarkdownStale = vi.fn()
    const base = {
      getPendingBrowserPageId: () => null,
      clearPendingBrowserPageId: vi.fn(),
      activateBrowserTab: vi.fn(),
      markActiveMarkdownStale
    }
    const markdown: Tab = {
      id: 'markdown-1',
      type: 'markdown',
      isActive: true,
      isDirty: true
    }

    runAcceptedMobileSessionTabsEffects({
      ...base,
      effectiveTabs: [markdown],
      source: 'list'
    })
    runAcceptedMobileSessionTabsEffects({
      ...base,
      effectiveTabs: [],
      source: 'stream'
    })
    expect(markActiveMarkdownStale).not.toHaveBeenCalled()

    runAcceptedMobileSessionTabsEffects({
      ...base,
      effectiveTabs: [markdown],
      source: 'stream'
    })
    expect(markActiveMarkdownStale).toHaveBeenCalledExactlyOnceWith('markdown-1')
  })
})
