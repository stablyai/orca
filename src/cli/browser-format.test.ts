import { describe, expect, it } from 'vitest'
import type { BrowserTabInfo } from '../shared/runtime-types'
import { formatTabList, formatTabShow } from './browser-format'

const tab = (clientHosted?: boolean): BrowserTabInfo => ({
  browserPageId: 'page-a',
  index: 0,
  url: 'https://example.test/',
  title: 'Example',
  active: true,
  ...(clientHosted === undefined ? {} : { clientHosted })
})

describe('browser tab formatting', () => {
  it('keeps placement out of normal output for progressive disclosure', () => {
    const expected = '* [0] page-a  Example — https://example.test/'

    expect(formatTabList({ tabs: [tab(true)] })).toBe(expected)
    expect(formatTabList({ tabs: [tab(false)] })).toBe(expected)
    expect(formatTabList({ tabs: [tab()] })).toBe(expected)
  })

  it('treats an absent mixed-version marker as unknown without changing normal output', () => {
    expect(formatTabShow({ tab: tab() })).toBe(
      [
        'page: page-a',
        'title: Example',
        'url: https://example.test/',
        'active: true',
        'worktree: unknown',
        'profile: unknown'
      ].join('\n')
    )
  })
})
