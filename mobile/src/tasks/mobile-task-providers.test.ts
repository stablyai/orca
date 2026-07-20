import { describe, expect, it } from 'vitest'
import {
  filterAvailableTaskProviders,
  normalizeVisibleTaskProviders,
  resolveVisibleTaskProvider
} from './mobile-task-providers'

describe('mobile task providers', () => {
  it('normalizes and deduplicates every supported provider', () => {
    expect(
      normalizeVisibleTaskProviders(['clickup', 'github', 'clickup', 'unknown', 'linear'])
    ).toEqual(['clickup', 'github', 'linear'])
  })

  it('gates ClickUp on the selected runtime connection', () => {
    expect(
      filterAvailableTaskProviders(['github', 'gitlab', 'linear', 'clickup'], {
        gitlabInstalled: false,
        linearConnected: true,
        clickUpConnected: false
      })
    ).toEqual(['github', 'linear'])
    expect(
      filterAvailableTaskProviders(['clickup'], {
        gitlabInstalled: false,
        linearConnected: false,
        clickUpConnected: true
      })
    ).toEqual(['clickup'])
  })

  it('resolves a preferred ClickUp source only while it remains visible', () => {
    expect(resolveVisibleTaskProvider('clickup', ['github', 'clickup'])).toBe('clickup')
    expect(resolveVisibleTaskProvider('clickup', ['github'])).toBe('github')
  })
})
