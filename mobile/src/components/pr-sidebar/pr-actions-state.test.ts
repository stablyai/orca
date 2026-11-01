import { describe, expect, it } from 'vitest'
import type { PRInfo } from '../../../../src/shared/github/pull-request-types'
import { presentPrMerge, resolvePrActionAvailability } from './pr-actions-state'

describe('resolvePrActionAvailability', () => {
  it('offers Ready for review instead of Merge on drafts, like desktop', () => {
    expect(resolvePrActionAvailability('draft')).toMatchObject({
      canMerge: false,
      canMarkReady: true,
      canClose: true
    })
    expect(resolvePrActionAvailability('open')).toMatchObject({
      canMerge: true,
      canMarkReady: false,
      canClose: true
    })
  })
})

describe('presentPrMerge', () => {
  const pr: PRInfo = {
    number: 202,
    title: 'API',
    state: 'open',
    url: 'https://example.test/202',
    checksStatus: 'success',
    updatedAt: '',
    mergeable: 'CONFLICTING'
  }
  const entry = {
    title: '',
    url: '',
    state: 'open' as const,
    checksStatus: 'success' as const,
    mergeable: 'MERGEABLE' as const
  }

  it('disables Merge with desktop copy when GitHub reports conflicts', () => {
    expect(presentPrMerge(pr, 'squash')).toMatchObject({
      enabled: false,
      label: 'Conflicts',
      hint: 'GitHub reports merge conflicts'
    })
  })

  it('lets a complete stack merge through, and names a blocking downstack PR', () => {
    const stack = {
      number: 51,
      position: 2,
      size: 3,
      baseRefName: 'main',
      entries: [
        { ...entry, position: 1, number: 201 },
        { ...entry, position: 2, number: 202 }
      ]
    }
    expect(presentPrMerge({ ...pr, stack }, 'squash')).toMatchObject({
      enabled: true,
      label: 'Merge through #202 · 2 PRs'
    })
    const blocked = {
      ...stack,
      entries: [{ ...entry, position: 1, number: 201, state: 'draft' as const }, stack.entries[1]]
    }
    expect(presentPrMerge({ ...pr, stack: blocked }, 'squash')).toMatchObject({
      enabled: false,
      hint: '#201 is still a draft.'
    })
  })
})
