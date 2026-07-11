import { describe, it, expect } from 'vitest'
import { parseSourceControlHubTab, SOURCE_CONTROL_HUB_TABS } from './mobile-source-control-hub-tab'

describe('parseSourceControlHubTab', () => {
  it('accepts each known tab', () => {
    for (const tab of SOURCE_CONTROL_HUB_TABS) {
      expect(parseSourceControlHubTab(tab)).toBe(tab)
    }
  })

  it('reads the first element of an array param', () => {
    expect(parseSourceControlHubTab(['pr', 'history'])).toBe('pr')
  })

  it('falls back to changes for unknown, empty, or missing values', () => {
    expect(parseSourceControlHubTab('nope')).toBe('changes')
    expect(parseSourceControlHubTab('')).toBe('changes')
    expect(parseSourceControlHubTab(undefined)).toBe('changes')
    expect(parseSourceControlHubTab(null)).toBe('changes')
    expect(parseSourceControlHubTab([])).toBe('changes')
  })
})
