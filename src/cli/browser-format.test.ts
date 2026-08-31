import { describe, expect, it } from 'vitest'
import type { BrowserTabInfo } from '../shared/runtime-types'
import { formatTabList, formatTabShow } from './browser-format'

function tab(overrides: Partial<BrowserTabInfo> = {}): BrowserTabInfo {
  return {
    browserPageId: 'page-1',
    index: 0,
    url: 'https://example.test',
    title: 'Example',
    active: true,
    ...overrides
  }
}

describe('browser tab placement formatting', () => {
  it('marks client-hosted pages in list and show output', () => {
    const clientTab = tab({
      placement: {
        kind: 'client',
        browserHostClientId: 'host-a',
        browserHostGeneration: 3,
        pageHostGeneration: 9
      }
    })

    expect(formatTabList({ tabs: [clientTab] })).toContain('[client-hosted]')
    expect(formatTabShow({ tab: clientTab })).toContain('placement: client')
  })

  it('treats an old host response without placement as unknown', () => {
    const legacyTab = tab()

    expect(formatTabList({ tabs: [legacyTab] })).toContain('[placement-unknown]')
    expect(formatTabShow({ tab: legacyTab })).toContain('placement: unknown')
  })
})
