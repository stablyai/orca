import { describe, expect, it } from 'vitest'
import {
  LocalDownloadedFolderPromotionBudget,
  type LocalDownloadedFolderPromotionLimits
} from './local-downloaded-folder-promotion-budget'

const limits: LocalDownloadedFolderPromotionLimits = {
  maximumEntries: 2,
  maximumDepth: 2,
  maximumPathBytes: 4,
  maximumRetainedPathBytes: 8
}

describe('LocalDownloadedFolderPromotionBudget', () => {
  it('accepts every exact boundary', () => {
    const budget = new LocalDownloadedFolderPromotionBudget(limits)

    budget.recordEntry('12', '34', 2)
    budget.recordEntry('56', '78', 2)
  })

  it.each([
    [
      'entries',
      (budget: LocalDownloadedFolderPromotionBudget) => {
        budget.recordEntry('', '', 0)
        budget.recordEntry('', '', 0)
        budget.recordEntry('', '', 0)
      }
    ],
    ['depth', (budget: LocalDownloadedFolderPromotionBudget) => budget.recordEntry('', '', 3)],
    ['path', (budget: LocalDownloadedFolderPromotionBudget) => budget.recordEntry('12345', '', 0)]
  ] as const)('rejects one unit beyond the %s boundary', (reason, exceed) => {
    expect(() => exceed(new LocalDownloadedFolderPromotionBudget(limits))).toThrow(
      expect.objectContaining({ reason })
    )
  })

  it('rejects one unit beyond the retained-path boundary', () => {
    const budget = new LocalDownloadedFolderPromotionBudget({
      ...limits,
      maximumEntries: 3
    })
    budget.recordEntry('12', '34', 0)
    budget.recordEntry('56', '78', 0)

    expect(() => budget.recordEntry('9', '', 0)).toThrow(
      expect.objectContaining({ reason: 'paths' })
    )
  })
})
